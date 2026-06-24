#!/usr/bin/env python3
"""Crawl carbonfiber360 product center and export product text.

The crawler starts at the product center, recursively follows product listing
and pagination pages, then opens each product detail page for category and
description text.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import time
from collections import deque
from dataclasses import asdict, dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable
from urllib.parse import urljoin, urlparse
from urllib.request import ProxyHandler, Request, build_opener


BASE_URL = "https://www.carbonfiber360.com"
START_URL = f"{BASE_URL}/product/5/"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
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
    value = re.sub(r"(?i)</div\s*>", "\n", value)
    value = re.sub(r"<[^>]+>", " ", value)
    value = html.unescape(value)
    lines = [clean_text(line) for line in value.splitlines()]
    return "\n".join(line for line in lines if line)


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[dict[str, str]] = []
        self._current: dict[str, str] | None = None
        self._chunks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a":
            return
        href = dict(attrs).get("href")
        if href:
            self._current = {"href": href}
            self._chunks = []

    def handle_data(self, data: str) -> None:
        if self._current is not None:
            self._chunks.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a" and self._current is not None:
            self._current["text"] = clean_text(" ".join(self._chunks))
            self.links.append(self._current)
            self._current = None
            self._chunks = []


@dataclass
class Product:
    product_id: str
    title: str
    category: str
    listing_category: str
    url: str
    summary: str
    detail: str
    keywords: str
    previous_product: str
    next_product: str


def fetch(url: str, timeout: int = 20, retries: int = 3, pause: float = 0.25) -> str:
    opener = build_opener(ProxyHandler({}))
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            req = Request(url, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"})
            with opener.open(req, timeout=timeout) as response:
                charset = response.headers.get_content_charset() or "utf-8"
                raw = response.read()
                return raw.decode(charset, errors="ignore")
        except Exception as exc:  # pragma: no cover - diagnostic path
            last_error = exc
            time.sleep(pause * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last_error}")


def links_from(html_text: str, page_url: str) -> list[dict[str, str]]:
    parser = LinkParser()
    parser.feed(html_text)
    results: list[dict[str, str]] = []
    for link in parser.links:
        href = link["href"].strip()
        if href.startswith("javascript:") or href.startswith("#") or href.startswith("mailto:") or href.startswith("tel:"):
            continue
        absolute = urljoin(page_url, href)
        parsed = urlparse(absolute)
        if parsed.netloc and parsed.netloc != "www.carbonfiber360.com":
            continue
        results.append({"href": absolute.split("#", 1)[0], "text": link.get("text", "")})
    return results


def is_listing_url(url: str) -> bool:
    path = urlparse(url).path
    return bool(re.fullmatch(r"/product/\d+/?", path) or re.fullmatch(r"/products_list/[\w-]+\.html", path))


def is_detail_url(url: str) -> bool:
    return bool(re.fullmatch(r"/products_detail/\d+\.html", urlparse(url).path))


def title_from(html_text: str) -> str:
    h1 = re.search(r"(?is)<h1[^>]*>(.*?)</h1>", html_text)
    if h1:
        return clean_text(strip_tags(h1.group(1)))
    title = re.search(r"(?is)<title[^>]*>(.*?)</title>", html_text)
    if title:
        return clean_text(strip_tags(title.group(1)).split("-")[0])
    return ""


def extract_between(text: str, start: str, end_patterns: Iterable[str]) -> str:
    start_pos = text.find(start)
    if start_pos < 0:
        return ""
    start_pos += len(start)
    end_pos = len(text)
    for pattern in end_patterns:
        pos = text.find(pattern, start_pos)
        if pos >= 0:
            end_pos = min(end_pos, pos)
    return clean_text(text[start_pos:end_pos])


def parse_detail(url: str, html_text: str, listing_category: str) -> Product:
    title = title_from(html_text)
    plain = strip_tags(html_text)
    compact = clean_text(plain)
    product_id = re.search(r"/(\d+)\.html", urlparse(url).path)

    category = extract_between(compact, "分类：", ["在线留言", "详细信息", "关键字:", "上一个"])
    summary = ""
    if title and title in compact and "分类：" in compact:
        after_title = compact.split(title, 1)[-1]
        summary = clean_text(after_title.split("分类：", 1)[0])
    detail = extract_between(compact, "详细信息", ["关键字:", "上一个", "在线留言 您好"])
    keywords = extract_between(compact, "关键字:", ["上一个", "下一个", "在线留言"])
    previous_product = extract_between(compact, "上一个", ["下一个", "在线留言", "相关产品"])
    next_product = extract_between(compact, "下一个", ["在线留言", "相关产品"])

    return Product(
        product_id=product_id.group(1) if product_id else "",
        title=title,
        category=category or listing_category,
        listing_category=listing_category,
        url=url,
        summary=summary,
        detail=detail,
        keywords=keywords,
        previous_product=previous_product,
        next_product=next_product,
    )


def infer_listing_category(html_text: str, page_url: str, fallback: str = "") -> str:
    title = title_from(html_text)
    if title and title not in {"产品中心"}:
        return title
    path = urlparse(page_url).path
    if path.startswith("/products_list/"):
        m = re.search(r"分类：\s*([^<\n]+)", html_text)
        if m:
            return clean_text(m.group(1))
    return fallback


def crawl(start_url: str = START_URL, max_pages: int = 800) -> tuple[list[Product], list[dict[str, str]]]:
    listing_seen: set[str] = set()
    detail_seen: set[str] = set()
    detail_queue: deque[tuple[str, str]] = deque()
    listing_queue: deque[tuple[str, str]] = deque([(start_url, "产品中心")])
    products: list[Product] = []
    categories: dict[str, str] = {}

    while listing_queue and len(listing_seen) < max_pages:
        page_url, parent_category = listing_queue.popleft()
        if page_url in listing_seen:
            continue
        listing_seen.add(page_url)
        page_html = fetch(page_url)
        listing_category = infer_listing_category(page_html, page_url, parent_category)
        for link in links_from(page_html, page_url):
            href = link["href"]
            text = link["text"]
            if is_listing_url(href):
                categories[href] = text or categories.get(href, "") or listing_category
                if href not in listing_seen:
                    listing_queue.append((href, text or listing_category))
            elif is_detail_url(href) and href not in detail_seen:
                detail_seen.add(href)
                detail_queue.append((href, listing_category))

    while detail_queue:
        detail_url, listing_category = detail_queue.popleft()
        detail_html = fetch(detail_url)
        products.append(parse_detail(detail_url, detail_html, listing_category))

    products.sort(key=lambda item: int(item.product_id or 0), reverse=True)
    category_rows = [{"url": url, "category": name} for url, name in sorted(categories.items(), key=lambda x: x[0])]
    return products, category_rows


def write_outputs(products: list[Product], category_rows: list[dict[str, str]], out_dir: Path) -> dict[str, str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "carbonfiber360_products.json"
    csv_path = out_dir / "carbonfiber360_products.csv"
    md_path = out_dir / "carbonfiber360_products.md"

    payload = {
        "source": START_URL,
        "product_count": len(products),
        "category_pages": category_rows,
        "products": [asdict(product) for product in products],
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    fieldnames = list(asdict(products[0]).keys()) if products else list(Product.__dataclass_fields__.keys())
    with csv_path.open("w", encoding="utf-8-sig", newline="") as fp:
        writer = csv.DictWriter(fp, fieldnames=fieldnames)
        writer.writeheader()
        for product in products:
            writer.writerow(asdict(product))

    grouped: dict[str, list[Product]] = {}
    for product in products:
        grouped.setdefault(product.category or "未分类", []).append(product)

    lines: list[str] = [
        "# CarbonFiber360 产品中心抓取结果",
        "",
        f"- 来源：{START_URL}",
        f"- 产品数量：{len(products)}",
        f"- 分类/分页入口数量：{len(category_rows)}",
        "",
        "## 分类入口",
        "",
    ]
    for row in category_rows:
        lines.append(f"- [{row['category'] or row['url']}]({row['url']})")
    lines.append("")

    for category, items in sorted(grouped.items(), key=lambda x: x[0]):
        lines.extend([f"## {category}", ""])
        for product in items:
            lines.extend(
                [
                    f"### {product.title}",
                    "",
                    f"- 产品 ID：{product.product_id}",
                    f"- 来源：{product.url}",
                    f"- 列表分类：{product.listing_category}",
                    f"- 关键词：{product.keywords or '无'}",
                    "",
                    "**简介**",
                    "",
                    product.summary or "无",
                    "",
                    "**详细信息**",
                    "",
                    product.detail or "无",
                    "",
                ]
            )

    md_path.write_text("\n".join(lines), encoding="utf-8")
    return {"json": str(json_path), "csv": str(csv_path), "markdown": str(md_path)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-url", default=START_URL)
    parser.add_argument("--out-dir", default="outputs/carbonfiber360")
    parser.add_argument("--max-pages", type=int, default=800)
    args = parser.parse_args()

    products, category_rows = crawl(args.start_url, args.max_pages)
    paths = write_outputs(products, category_rows, Path(args.out_dir))
    print(json.dumps({"count": len(products), **paths}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
