# MirrorKit Hub

> 🔀 **Fork of [ZzaiQWQ/MirrorKit](https://github.com/ZzaiQWQ/MirrorKit)** — 基于原版 MirrorKit 的增强分支，新增可视化控制面板、SPA 根路径服务模式和二进制资产保护机制。

[中文](#mirrorkit-hub) | [English](#english)

---

## 这是什么

MirrorKit Hub 是一个网页离线镜像框架，能够将任意网站完整抓取到本地，并通过本地代理服务器实现像素级的离线浏览。

**核心规则：**

```
所有资源先走本地 → 本地没有，再去远程请求 → 请求成功后，缓存到本地 → 以后再访问，直接读本地
```

本 Fork 在原版基础上进行了以下增强，使其能够完美支持现代复杂的 3D/SPA 站点（如 Astro、React Router、Three.js 类站点）。

## 相比原版，新增了什么

### 🎛️ MirrorLauncher — 可视化控制面板

原版需要手动编辑 `server.js` 顶部配置来切换目标站点。本 Fork 新增了一个独立的图形化控制面板（`MirrorLauncher/`），提供：

- **站点预设管理**：通过 Web 界面创建、编辑、删除站点配置，无需修改代码
- **一键启停**：在面板中直接启动/停止代理服务器和批量下载器
- **实时日志终端**：通过 SSE 推流实时查看服务器和下载器的运行日志
- **代理支持**：内置网络代理配置，适配需要翻墙的场景

### 🏠 SERVE_AT_ROOT — 根路径服务模式

解决了现代 SPA 框架在子目录镜像路径下的路由崩溃问题。

| | 原版模式 | 根路径模式 |
| :--- | :--- | :--- |
| 访问地址 | `http://localhost:3000/site.com/` | `http://localhost:3000/` |
| SPA 路由 | ❌ 路由匹配失败（把 `site.com` 当作路由路径） | ✅ 完美运行 |
| JS 修改 | 需要修改压缩 JS 中的路由逻辑 | **零修改，100% 无损** |

启用方式：设置环境变量 `SERVE_AT_ROOT=true`，或在控制面板中配置。

### 🔒 二进制资产保护

- **Magic Bytes 嗅探**：对无扩展名的字体文件（如 Adobe Typekit），通过检测文件头部的二进制魔数（`wOF2` / `wOFF`）精准识别 MIME 类型
- **重写隔离**：仅对 HTML 类文本进行 URL 重写，二进制资源（字体、3D 模型、纹理）100% 绕过文本替换引擎，杜绝数据损坏

## 项目结构

```
MirrorKit-Hub/
├── MirrorKit/                  # 核心代理服务器（基于原版增强）
│   ├── server.js               # 本地代理服务器
│   ├── tools/                  # 批量下载与校验工具
│   │   ├── mirror-assets.js    # 通用资源批量下载
│   │   ├── mirror-cms-media.js # CMS 隐藏媒体补充下载
│   │   ├── validate-assets.js  # 本地资源校验
│   │   └── find-video-refs.js  # 视频引用查找
│   ├── index.html              # 框架启动引导页
│   └── README.md               # 原版详细使用说明
│
├── MirrorLauncher/             # 可视化控制面板（本 Fork 新增）
│   ├── launcher.js             # 控制面板后端
│   ├── launcher-ui.html        # 控制面板前端界面
│   ├── proxy-bootstrap.js      # 网络代理预加载脚本
│   └── presets.json.example    # 站点预设示例
│
└── 一键启动控制面板.bat          # Windows 一键启动入口
```

## 快速开始

### 环境要求

- **Node.js 18+**（运行 `node -v` 确认版本）
- 现代浏览器（Chrome / Edge / Firefox）

### 方式一：通过控制面板（推荐）

```bash
# 1. 安装 MirrorLauncher 依赖（仅首次）
cd MirrorLauncher
npm install
cd ..

# 2. 启动控制面板
node MirrorLauncher/launcher.js
```

或直接双击 `一键启动控制面板.bat`。

浏览器会自动打开 `http://localhost:4000/`，在面板中：
1. 创建站点预设（填入目标网址）
2. 点击「启动服务」一键开服
3. 访问 `http://localhost:3000/` 预览镜像

### 方式二：命令行直接使用

```bash
# 通过环境变量指定目标站点
set TARGET_HOST=https://example.com
set MIRROR_NAME=example.com
set START_PATH=/

# 批量下载资源
node MirrorKit/tools/mirror-assets.js

# 启动本地服务器
cd MirrorKit
node server.js
```

访问 `http://localhost:3000/` 即可浏览。

### 针对复杂 SPA / 3D 站点

如果目标站点使用了 Astro、React Router、Next.js 等前端框架，建议启用根路径模式：

```bash
set SERVE_AT_ROOT=true
node server.js
```

此模式下，镜像直接服务于 `/` 根路径，前端路由无需任何改动即可完美运行。

## 详细文档

关于换站配置、工具用法、扩展名补充、常见问题等详细说明，请参阅原版文档：

- [MirrorKit 详细使用说明（中文）](MirrorKit/README.md)
- [MirrorKit Detailed Guide (English)](MirrorKit/README_EN.md)

## 致谢

本项目基于 [ZzaiQWQ/MirrorKit](https://github.com/ZzaiQWQ/MirrorKit) 进行二次开发，感谢原作者的优秀架构设计。

原版协议为 GNU AGPL v3，本 Fork 的新增代码（MirrorLauncher、SERVE_AT_ROOT、二进制保护等）以 MIT 协议发布。

## 免责声明

本项目仅供学习研究、技术交流和本地测试使用。通过本工具下载的所有第三方网站资源仅限个人学习，未经授权不得商用或公开传播。详见 [DISCLAIMER.md](MirrorKit/DISCLAIMER.md)。

---

<a name="english"></a>

## English

### What is this

MirrorKit Hub is an enhanced fork of [ZzaiQWQ/MirrorKit](https://github.com/ZzaiQWQ/MirrorKit) — a web page offline mirroring framework that downloads entire websites for local pixel-perfect browsing.

### What's new in this fork

- **MirrorLauncher** — A visual control panel with site preset management, one-click server start/stop, real-time log streaming, and proxy support
- **SERVE_AT_ROOT mode** — Serves mirrors directly at `/` root path, solving SPA routing failures without modifying any minified JS
- **Binary asset protection** — Magic-byte sniffing for extensionless font files and rewrite isolation for binary assets

### Quick Start

```bash
# Install MirrorLauncher dependencies (first time only)
cd MirrorLauncher && npm install && cd ..

# Launch the control panel
node MirrorLauncher/launcher.js
# Or double-click: 一键启动控制面板.bat
```

Open `http://localhost:4000/` in your browser, create a site preset, and start mirroring.

For complex SPA/3D sites, enable root-path mode: `set SERVE_AT_ROOT=true`

### License

New code (MirrorLauncher, SERVE_AT_ROOT, binary protection) is released under MIT License. The original MirrorKit core was licensed under GNU AGPL v3. See [LICENSE](MirrorKit/LICENSE).

### Disclaimer

This project is for learning, research, and local testing only. See [DISCLAIMER.md](MirrorKit/DISCLAIMER.md).
