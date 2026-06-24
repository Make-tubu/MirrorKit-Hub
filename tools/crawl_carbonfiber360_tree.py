#!/usr/bin/env python3
"""Crawl carbonfiber360 products as a left-navigation tree.

This version uses the left sidebar as the source of truth for hierarchy:
全部分类 -> 一级分类 -> 二级分类 -> 产品.

It avoids the all-products landing page as a product category, deduplicates
detail pages globally, and extracts only the central product detail text.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse
from urllib.request import ProxyHandler, Request, build_opener


BASE_URL = "https://www.carbonfiber360.com"
START_URL = f"{BASE_URL}/product/5/"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)
DETAIL_BOILERPLATE_STARTS = (
    "东莞市巨力复合材料科技有限公司是中国领先",
    "东莞市聚力复合材料科技有限公司是中国领先",
    "我们的产品范围丰富多样",
    "关于我们公司：",
    "我们的公司成立于2011年",
    "产品图片和一些认证如下",
)


def clean_text(value: str) -> str:
    value = html.unescape(value or "")
    value = value.replace("\xa0", " ")
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def strip_tags(value: str) -> str:
    value = re.sub(r"(?is)<script.*?</script>", " ", value)
    value = re.sub(r"(?is)<style.*?</style>", " ", value)
    value = re.sub(r"(?i)<br\s*/?>", "\n", value)
    value = re.sub(r"(?i)</p\s*>", "\n", value)
    value = re.sub(r"(?i)</li\s*>", "\n", value)
    value = re.sub(r"<[^>]+>", " ", value)
    value = html.unescape(value)
    lines = [clean_text(line) for line in value.splitlines()]
    return "\n".join(line for line in lines if line)


def log(message: str) -> None:
    print(message, flush=True)


def fetch(url: str, *, data: dict[str, Any] | None = None, retries: int = 2) -> str:
    opener = build_opener(ProxyHandler({}))
    body = None
    headers = {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"}
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            req = Request(url, data=body, headers=headers)
            with opener.open(req, timeout=18) as response:
                charset = response.headers.get_content_charset() or "utf-8"
                return response.read().decode(charset, errors="ignore")
        except Exception as exc:
            last_error = exc
            time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last_error}")


@dataclass
class Product:
    id: str
    title: str
    url: str
    nav_path: str
    site_category: str
    summary: str
    detail: str
    keywords: str
    cover_image: str = ""


@dataclass
class CategoryNode:
    name: str
    url: str
    level: int
    products: list[Product] = field(default_factory=list)
    children: list["CategoryNode"] = field(default_factory=list)


class SidebarParser(HTMLParser):
    def __init__(self, page_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.page_url = page_url
        self.nodes: list[CategoryNode] = []
        self.current_top: CategoryNode | None = None
        self._title_level: int | None = None
        self._href: str | None = None
        self._chunks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = dict(attrs)
        if tag == "p":
            cls = attrs_dict.get("class", "")
            if "p_c_title1" in cls:
                self._title_level = 1
            elif "p_c_title2" in cls:
                self._title_level = 2
        elif tag == "a" and self._title_level:
            self._href = attrs_dict.get("href")
            self._chunks = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._chunks.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._href is not None and self._title_level:
            name = clean_text(" ".join(self._chunks))
            url = urljoin(self.page_url, self._href).split("#", 1)[0]
            if name:
                node = CategoryNode(name=name, url=url, level=self._title_level)
                if self._title_level == 1:
                    self.nodes.append(node)
                    self.current_top = node
                elif self.current_top is not None:
                    self.current_top.children.append(node)
            self._href = None
            self._chunks = []
        elif tag == "p":
            self._title_level = None


def sidebar_html(page_html: str) -> str:
    start = page_html.find('<div class="p_c_tree">')
    if start < 0:
        return ""
    end = page_html.find('<div class="p_c_mput', start)
    return page_html[start:end] if end > start else page_html[start:]


def parse_sidebar(page_html: str, page_url: str) -> CategoryNode:
    parser = SidebarParser(page_url)
    parser.feed(sidebar_html(page_html))
    return CategoryNode(name="全部分类", url=page_url, level=0, children=parser.nodes)


def extract_config(page_html: str) -> dict[str, Any] | None:
    match = re.search(r'<input type="hidden" name="_config" value="([\s\S]*?)">', page_html)
    if not match:
        return None
    value = html.unescape(match.group(1))
    value = value.replace("&#x3D;", "=")
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def list_products(category_url: str) -> list[dict[str, Any]]:
    page_html = fetch(category_url)
    config = extract_config(page_html)
    if not config:
        return []
    api = urljoin(category_url, config["api"])
    params = config["params"]
    size = int(params.get("size", 12))
    total = None
    products: list[dict[str, Any]] = []
    offset = 0
    while total is None or offset < total:
        params["from"] = offset
        payload = json.loads(fetch(api, data=params))
        data = payload.get("data", {})
        page = data.get("page", {})
        total = int(page.get("totalCount", 0))
        batch = data.get("list", [])
        products.extend(batch)
        if not batch:
            break
        offset += size
    return products


def detail_url_from(item: dict[str, Any]) -> str:
    href = item.get("href") or item.get("hrefObject", {}).get("value") or ""
    return urljoin(BASE_URL, href)


def detail_id_from_url(url: str) -> str:
    match = re.search(r"/products_detail/(\d+)\.html", urlparse(url).path)
    return match.group(1) if match else ""


def title_from(page_html: str) -> str:
    h1 = re.search(r"(?is)<h1[^>]*>(.*?)</h1>", page_html)
    if h1:
        return clean_text(strip_tags(h1.group(1)))
    title = re.search(r"(?is)<title[^>]*>(.*?)</title>", page_html)
    return clean_text(strip_tags(title.group(1)).split("-")[0]) if title else ""


def extract_rich_text(page_html: str, class_name: str) -> str:
    match = re.search(
        rf'(?is)<div class="{re.escape(class_name)}[^"]*">(.*?)</div>',
        page_html,
    )
    return strip_tags(match.group(1)) if match else ""


def parse_detail(detail_url: str, nav_path: str, api_item: dict[str, Any]) -> Product:
    page_html = fetch(detail_url)
    detail = extract_rich_text(page_html, "e_richText-86")
    for marker in DETAIL_BOILERPLATE_STARTS:
        pos = detail.find(marker)
        if pos >= 0:
            detail = clean_text(detail[:pos])
    summary = clean_text(api_item.get("summary") or "")
    keywords = ", ".join(
        item.get("name", "") for item in (api_item.get("keywordObject") or []) if item.get("name")
    )
    cover_image = api_item.get("coverImage") or ""
    if cover_image and not cover_image.startswith("http"):
        cover_image = "https://omo-oss-image.thefastimg.com/" + cover_image.lstrip("/")
    return Product(
        id=detail_id_from_url(detail_url),
        title=title_from(page_html) or api_item.get("title", ""),
        url=detail_url,
        nav_path=nav_path,
        site_category=api_item.get("categoryName") or "",
        summary=summary,
        detail=detail,
        keywords=keywords,
        cover_image=cover_image,
    )


def category_nodes_specific_first(root: CategoryNode) -> list[tuple[CategoryNode, str]]:
    result: list[tuple[CategoryNode, str]] = []

    def walk(node: CategoryNode, parents: list[str]) -> None:
        path = parents + [node.name]
        for child in node.children:
            walk(child, path)
        if node.level > 0:
            result.append((node, " -> ".join(path)))

    walk(root, [])
    return result


def crawl(start_url: str = START_URL) -> CategoryNode:
    start_html = fetch(start_url)
    root = parse_sidebar(start_html, start_url)
    seen_details: set[str] = set()
    detail_jobs: list[tuple[CategoryNode, str, str, dict[str, Any]]] = []

    for node, nav_path in category_nodes_specific_first(root):
        log(f"[category] {nav_path}")
        items = list_products(node.url)
        log(f"  products from API: {len(items)}")
        for item in items:
            detail_url = detail_url_from(item)
            if not detail_url or "/products_detail/" not in detail_url:
                continue
            detail_id = detail_id_from_url(detail_url)
            if detail_id in seen_details:
                continue
            seen_details.add(detail_id)
            detail_jobs.append((node, nav_path, detail_url, item))

    log(f"[details] unique detail pages: {len(detail_jobs)}")
    completed = 0
    with ThreadPoolExecutor(max_workers=8) as executor:
        future_map = {
            executor.submit(parse_detail, detail_url, nav_path, item): node
            for node, nav_path, detail_url, item in detail_jobs
        }
        for future in as_completed(future_map):
            node = future_map[future]
            product = future.result()
            node.products.append(product)
            completed += 1
            if completed % 10 == 0 or completed == len(detail_jobs):
                log(f"  fetched details: {completed}/{len(detail_jobs)}")

    def sort_node(node: CategoryNode) -> None:
        node.products.sort(key=lambda product: int(product.id or 0), reverse=True)
        for child in node.children:
            sort_node(child)

    sort_node(root)
    return root


def node_to_dict(node: CategoryNode) -> dict[str, Any]:
    return {
        "name": node.name,
        "url": node.url,
        "level": node.level,
        "products": [product.__dict__ for product in node.products],
        "children": [node_to_dict(child) for child in node.children],
    }


def count_products(node: CategoryNode) -> int:
    return len(node.products) + sum(count_products(child) for child in node.children)


def write_markdown(root: CategoryNode, output_path: Path) -> None:
    def safe_markdown_text(value: str) -> str:
        lines = []
        for line in (value or "").splitlines():
            line = line.rstrip()
            if line.startswith("#"):
                line = "\\" + line
            lines.append(line)
        return "\n".join(lines).strip()

    lines: list[str] = [
        "# CarbonFiber360 产品中心树状抓取结果",
        "",
        f"- 来源：{START_URL}",
        f"- 去重后产品数：{count_products(root)}",
        "- 分类依据：产品中心左侧导航栏",
        "- 正文范围：详情页中间“详细信息”产品正文，已去除页眉、页脚、在线留言、相关产品和公司通用介绍",
        "",
    ]

    def write_node(node: CategoryNode, depth: int) -> None:
        if node.level == 0:
            lines.append(f"## {node.name}")
        elif depth <= 2:
            lines.append(f"{'#' * (depth + 2)} {node.name}")
            lines.append("")
            lines.append(f"- 分类页：{node.url}")
            lines.append(f"- 本节点产品数：{len(node.products)}")
        else:
            lines.append(f"{'#' * 4} {node.name}")
        lines.append("")
        if node.products:
            lines.append("**产品**")
            lines.append("")
            for product in node.products:
                lines.append(f"#### 产品：{product.title}")
                lines.append("")
                lines.append(f"- 链接：{product.url}")
                if product.site_category:
                    lines.append(f"- 官网分类：{product.site_category}")
                if product.keywords:
                    lines.append(f"- 关键词：{product.keywords}")
                if product.summary:
                    lines.append("")
                    lines.append("**简介**")
                    lines.append("")
                    lines.append(product.summary)
                if product.detail:
                    lines.append("")
                    lines.append("**产品正文**")
                    lines.append("")
                    lines.append(safe_markdown_text(product.detail))
                lines.append("")
        for child in node.children:
            write_node(child, depth + 1)

    write_node(root, 0)
    output_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-url", default=START_URL)
    parser.add_argument("--out-dir", default="outputs/carbonfiber360")
    args = parser.parse_args()

    root = crawl(args.start_url)
    output_dir = Path(args.out_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "carbonfiber360_product_tree.json"
    md_path = output_dir / "carbonfiber360_product_tree.md"
    json_path.write_text(json.dumps(node_to_dict(root), ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(root, md_path)
    print(json.dumps({"products": count_products(root), "markdown": str(md_path), "json": str(json_path)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
