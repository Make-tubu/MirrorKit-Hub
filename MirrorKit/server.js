const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ====== 站点配置区：换网站时主要改这里 ======
// PORT：本地服务器端口。默认 3000，可以用环境变量 PORT 覆盖。
const PORT = Number(process.env.PORT || 3000);

// TARGET_HOST：目标网站源站，只写协议 + 域名，不要带最后的斜杠。
// 默认使用 example.com 作为占位示例，避免把某个真实网站当成框架默认内容。
// 真正扒站时，把这里改成目标站点，例如 https://www.example-site.com。
const TARGET_HOST = process.env.TARGET_HOST || 'https://example.com';

// MIRROR_NAME：本地镜像文件夹名。
// 规则：不管扒什么网站，所有目标网站内容都先进这个文件夹。
// 外层 index.html 永远只做框架说明页，不保存目标网站首页。
// 默认用目标域名去掉开头的 www.，例如 www.example-site.com -> example-site.com。
const MIRROR_NAME = process.env.MIRROR_NAME || 'example.com';

// START_PATH：目标站点入口路径。
const START_PATH = process.env.START_PATH || '/';

// SERVE_AT_ROOT：是否直接在根路径服务镜像，而不是在二级目录下。
// 开启后，本地镜像将直接服务于根路径 /，完美解决 Astro、React Router 等单页路由的二级路径匹配冲突，
// 且 100% 避免修改/损坏任何压缩 JS。对于复杂 SPA/3D 站点，强烈推荐设为 true。
const SERVE_AT_ROOT = process.env.SERVE_AT_ROOT === '1' || process.env.SERVE_AT_ROOT === 'true';

// REQUEST_TIMEOUT_MS：单个远程请求超时时间，防止某个资源一直卡住。
const REQUEST_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS || 30000);

// OFFLINE_MODE：纯离线模式开关。
// 开启后不再向远程站抓取任何资源，仅服务本地已有文件。
// 适合已经下载完成、只想本地预览的场景，避免意外覆盖已有资源。
const OFFLINE_MODE = process.env.OFFLINE_MODE === '1' || process.env.OFFLINE_MODE === 'true';

// REMOTE_MIRRORS：手动远程资源映射。
// 这个数组不是绑定某一个网站的规则；如果别的网站也有同样结构，也可以继续用。
// 例子：
// { prefix: '/cdn.example.com/', origin: 'https://cdn.example.com' }
const REMOTE_MIRRORS = [];

// BUILTIN_REMOTE_MIRRORS：内置通用映射。
// 当前保持为空，避免把某个旧网站的 CDN 专用地址写死到框架里。
const BUILTIN_REMOTE_MIRRORS = [];

// IGNORED_PATH_PREFIXES：浏览器、插件、OAuth、MCP 等探测请求。
// 这些通常不是目标网站资源，不缓存，避免日志刷屏。
const IGNORED_PATH_PREFIXES = [
    '/.well-known/',
    '/bb-mcp'
];

// ====== 通用规则区：不是某个网站专用，不要随便删 ======
// 有些站点资源路径带点，例如 /etc.clientlibs/...，它不是远程域名。
// 这些前缀应当继续拼到 TARGET_HOST 后面去抓。
const SITE_PATH_PREFIXES = new Set([
    'content',
    'etc.clientlibs',
    'experiment',
    'webui',
    'auth',
    'graphql'
]);

// 判断路径第一段是否像“被本地化后的远程域名”。
// 例如 /assets.adobedtm.com/a.js 可以代理到 https://assets.adobedtm.com/a.js。
// 要求至少两个点，是为了避免把 /etc.clientlibs/... 误判成域名。
// 修正：对于像 unpkg.com、webflow.com 等常见的单个点顶级域名，我们允许匹配。
function looksLikeMirroredRemoteHost(segment) {
    if (/^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/i.test(segment)) {
        return true;
    }
    // 允许单个点，但后缀必须是常见的 TLD 域名，以此完美兼容 unpkg.com 和 webflow.com 并避开 etc.clientlibs
    return /^[a-z0-9-]+\.(com|net|org|io|cn|cc|co|app|dev|me|xyz|info|tv)$/i.test(segment);
}

// 运行时只重写 HTML/CSS。
// 不能重写 JS：很多压缩脚本里有正则、模板字符串和转义 URL，粗暴替换会把脚本改坏，
// 典型表现就是菜单、轮播、弹窗等交互全部点不开。
const REWRITE_TEXT_EXTS = new Set(['.html', '.css']);

// JS/JSON 只做“外链前缀 -> 本地镜像前缀”的精确替换。
// 这样离线时媒体、CMS、第三方脚本会先走 localhost，但不会破坏压缩 JS 里的正则。
const EXTERNAL_URL_REWRITE_TEXT_EXTS = new Set(['.js', '.mjs', '.json']);
const REWRITE_ASSET_EXTS = [
    'avif', 'bin', 'css', 'exr', 'gif', 'glb', 'gltf', 'html', 'ico', 'jpg', 'jpeg', 'js', 'json',
    'ktx', 'ktx2', 'mjs', 'mov', 'mp3', 'mp4', 'otf', 'png', 'svg', 'ttf',
    'wasm', 'wav', 'webm', 'webp', 'woff', 'woff2'
];

// MIME_TYPES：告诉浏览器每类文件应该怎么解析。
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.otf': 'font/opentype',
    '.ttf': 'font/ttf',
    '.bin': 'application/octet-stream',
    '.ktx': 'image/ktx',
    '.ktx2': 'image/ktx2',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.exr': 'image/x-exr',
    '.zip': 'application/zip'
};

// MAGIC_BYTES：常见二进制文件头校验。
// 作用：防止远程返回 HTML 错误页，却被保存成 jpg/png/wasm/font。
const MAGIC_BYTES = {
    '.png': [0x89, 0x50, 0x4e, 0x47],
    '.jpg': [0xff, 0xd8, 0xff],
    '.jpeg': [0xff, 0xd8, 0xff],
    '.gif': [0x47, 0x49, 0x46],
    '.webp': [0x52, 0x49, 0x46, 0x46],
    '.wasm': [0x00, 0x61, 0x73, 0x6d],
    '.woff': [0x77, 0x4f, 0x46, 0x46],
    '.woff2': [0x77, 0x4f, 0x46, 0x32],
    '.ktx': [0xab, 0x4b, 0x54, 0x58],
    '.ktx2': [0xab, 0x4b, 0x54, 0x58]
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);

function isMirrorRequest(reqPath) {
    if (SERVE_AT_ROOT) return true;
    return reqPath === `/${MIRROR_NAME}` || reqPath.startsWith(`/${MIRROR_NAME}/`);
}

function stripMirrorPrefix(reqPath) {
    if (SERVE_AT_ROOT) return reqPath;
    if (reqPath === `/${MIRROR_NAME}`) return '/';
    return reqPath.slice(MIRROR_NAME.length + 1) || '/';
}

// 页面路由通常没有扩展名，例如 /about、/cn/about。
// 本地保存时统一落成 index.html，避免浏览器把无扩展名文件当下载文件。
function isRoutePath(reqPath) {
    const ext = path.extname(reqPath).toLowerCase();
    if (ext !== '') return false;
    
    // 如果请求的第一部分是一个被代理的外部域名（例如 use.typekit.net），说明它肯定是个静态资产而不是 HTML 路由！
    const parts = reqPath.split('/').filter(Boolean);
    if (parts.length > 0 && looksLikeMirroredRemoteHost(parts[0])) {
        return false;
    }
    return true;
}

function isHtmlLike(buffer) {
    const head = buffer.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
    return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<title>');
}

function hasExpectedMagic(filePath, buffer) {
    const ext = path.extname(filePath).toLowerCase();
    const magic = MAGIC_BYTES[ext];
    if (!magic) return true;
    if (buffer.length < magic.length) return false;
    return magic.every((byte, index) => buffer[index] === byte);
}

// 这是缓存安全阀：不要把 HTML fallback 错误页存成图片、字体、JSON 等假资源。
function isValidCachedResponse(filePath, response, buffer) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = (response.headers.get('content-type') || '').toLowerCase();

    // 有些站点扩展名不准，例如 .png 实际返回 image/jpeg。
    // 只要响应明确是图片，就允许保存。
    // 注意：必须在 isHtmlLike 检查之前，因为 SVG 文件以 <svg 开头会被误判为 HTML。
    if (IMAGE_EXTS.has(ext) && contentType.startsWith('image/')) {
        return true;
    }

    if (isHtmlLike(buffer) && ext !== '.html' && ext !== '') {
        return false;
    }

    if (ext === '.json') {
        try {
            JSON.parse(buffer.toString('utf8'));
            return true;
        } catch {
            return false;
        }
    }

    if (ext === '.js' || ext === '.mjs') {
        return !contentType.includes('text/html');
    }

    return hasExpectedMagic(filePath, buffer);
}

function ensureDirExists(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

// 把 URL 路径 safe 映射到项目目录内。
// 核心规则：目标网站内容必须放在 MIRROR_NAME 文件夹里。
function getLocalPath(reqPath) {
    const baseDir = __dirname;
    let safePath = decodeURIComponent(reqPath);

    if (!isMirrorRequest(safePath)) {
        safePath = path.posix.join('/', MIRROR_NAME, safePath);
    }

    const targetPath = stripMirrorPrefix(safePath);
    
    // 在根路径模式下，我们需要把物理路径定位到 MIRROR_NAME 子目录中
    let diskPath = safePath;
    if (SERVE_AT_ROOT) {
        diskPath = path.posix.join('/', MIRROR_NAME, safePath);
    }

    if (isRoutePath(targetPath)) {
        diskPath = path.posix.join(diskPath, 'index.html');
    }

    // Windows 平台下，URL 路径中可能包含冒号等非法字符（例如 Cloudinary 的 q_auto:best），需要过滤为下划线
    if (process.platform === 'win32') {
        diskPath = diskPath.replace(/[:*?"<>|]/g, '_');
    }

    const normalizedPath = path.normalize(diskPath).replace(/^(\.\.[/\\])+/, '');
    const localPath = path.join(baseDir, 'mirrors', normalizedPath);
    const resolvedBase = path.resolve(baseDir);
    const resolvedLocal = path.resolve(localPath);

    if (!resolvedLocal.startsWith(resolvedBase)) {
        return null;
    }

    return localPath;
}

function getContentType(filePath, data) {
    const ext = path.extname(filePath).toLowerCase();
    if (!ext && data && isHtmlLike(data)) return MIME_TYPES['.html'];
    
    // 如果无扩展名但数据匹配 woff2/woff 魔数，则正确返回对应字体 MIME 头
    if (!ext && data && data.length >= 4) {
        if (data[0] === 0x77 && data[1] === 0x4f && data[2] === 0x46 && data[3] === 0x32) {
            return 'font/woff2';
        }
        if (data[0] === 0x77 && data[1] === 0x4f && data[2] === 0x46 && data[3] === 0x46) {
            return 'font/woff';
        }
    }
    
    return MIME_TYPES[ext] || 'application/octet-stream';
}

function serveLocalFile(filePath, res, req) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Error reading file: ${err.code}`);
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        // 如果没有扩展名，只有在内容本身是 HTML-like 文本时才进行文本重写，防止误改 extensionless 的二进制字体文件
        if (REWRITE_TEXT_EXTS.has(ext) || (ext === '' && isHtmlLike(data))) {
            data = Buffer.from(rewriteTextForLocalMirror(data.toString('utf8'), req));
        } else if (EXTERNAL_URL_REWRITE_TEXT_EXTS.has(ext)) {
            data = Buffer.from(rewriteExternalUrlsForLocalMirror(data.toString('utf8'), req));
        }

        res.writeHead(200, {
            'Content-Type': getContentType(filePath, data),
            'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
    });
}

function getMirrorEntryPath() {
    if (SERVE_AT_ROOT) return '/';
    const startPath = START_PATH.startsWith('/') ? START_PATH : `/${START_PATH}`;
    return startPath === '/' ? `/${MIRROR_NAME}/` : `/${MIRROR_NAME}${startPath}`;
}

// 外层入口页由服务器注入当前配置。
// 这样 index.html 不需要写死网站名，也不需要先靠浏览器额外 fetch 才知道入口路径。
function serveStarterPage(res) {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, 'utf8', (err, text) => {
        if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Error reading file: ${err.code}`);
            return;
        }

        const config = {
            targetHost: TARGET_HOST,
            mirrorName: MIRROR_NAME,
            startPath: START_PATH,
            entryPath: getMirrorEntryPath()
        };

        const html = text.replace(
            'window.__MIRROR_CONFIG__ = null;',
            `window.__MIRROR_CONFIG__ = ${JSON.stringify(config)};`
        );

        res.writeHead(200, {
            'Content-Type': MIME_TYPES['.html'],
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(html);
    });
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTargetHostName() {
    return new URL(TARGET_HOST).hostname;
}

function getRequestOrigin(req) {
    if (!req) return `http://localhost:${PORT}`;
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || `localhost:${PORT}`;
    return `${protocol}://${host}`;
}

function getLocalUrlPrefixForHost(host, slash, req) {
    const isEscaped = (slash === '\\/');
    const separator = isEscaped ? '\\/' : '/';
    
    const origin = getRequestOrigin(req);
    let base = origin;
    if (isEscaped) {
        base = base.replace(/\//g, '\\/');
    }

    if (host === getTargetHostName()) {
        if (SERVE_AT_ROOT) return `${base}${separator}`;
        return `${base}${separator}${MIRROR_NAME}${separator}`;
    }

    if (SERVE_AT_ROOT) return `${base}${separator}${host}${separator}`;
    return `${base}${separator}${MIRROR_NAME}${separator}${host}${separator}`;
}

// 重写所有明确写出来的 http/https 外链前缀。
// 例子：
// https://cdn.example.com/a.js -> /当前镜像文件夹/cdn.example.com/a.js
// https://目标站/assets/a.js -> /当前镜像文件夹/assets/a.js
// 如果 JS 里是 https:\/\/cdn.example.com\/a.js，也保持转义斜杠形式。
function rewriteExternalUrlsForLocalMirror(text, req) {
    const plainUrl = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})(\/)/gi;
    const escapedUrl = /\bhttps?:\\\/\\\/([a-z0-9.-]+\.[a-z]{2,})(\\\/)/gi;

    return text
        .replace(plainUrl, (match, host, slash) => {
            if (host.toLowerCase().includes('w3.org')) {
                return match;
            }
            return getLocalUrlPrefixForHost(host, slash, req);
        })
        .replace(escapedUrl, (match, host, slash) => {
            if (host.toLowerCase().includes('w3.org')) {
                return match;
            }
            return getLocalUrlPrefixForHost(host, slash, req);
        });
}

// 把页面里的远程 URL 改成本地镜像 URL。
// 例如 https://cdn.example.com/a.js -> /example-site.com/cdn.example.com/a.js。
function rewriteTextForLocalMirror(text, req) {
    const extGroup = REWRITE_ASSET_EXTS.join('|');
    const mirror = escapeRegExp(MIRROR_NAME);
    const assetUrl = new RegExp('https?:\\/\\/([^/"\\\'\\s)]+)(\\/[^"\\\'\\s)]+?\\.(?:' + extGroup + ')(?:\\?[^"\\\'\\s)]*)?)', 'gi');
    const rootAsset = new RegExp('(["\\\'(=])\\/(?!\\/|' + mirror + '\\/)([^"\\\'\\s)]+?\\.(?:' + extGroup + ')(?:\\?[^"\\\'\\s)]*)?)', 'gi');
    const rootRoute = new RegExp('(["\\\'=])\\/(?!\\/|' + mirror + '\\/)([a-z]{2}(?:-[a-z]{2})?(?:\\/[^"\\\'\\s<)]*)?)', 'gi');

    // 自动清除 HTML 中的 SRI 完整性校验（integrity）、跨域校验（crossorigin）以及 Cookiebot 第三方脚本，防止在 localhost 运行时产生 SSL 协议握手错误或 404
    let cleanText = text
        .replace(/<script[^>]*src=["'][^"']*cookiebot[^"']*["'][^>]*><\/script>/gi, '<!-- Cookiebot blocked -->')
        .replace(/<script[^>]*id=["']Cookiebot["'][^>]*>([\s\S]*?)<\/script>/gi, '<!-- Cookiebot blocked -->')
        .replace(/\bintegrity=(["'])(?:(?!\1).)*\1/gi, '')
        .replace(/\bcrossorigin=(["'])(?:(?!\1).)*\1/gi, '');

    // 强行注入反 Service Worker 劫持代码，并挂载全局 Cookiebot 挡板桩防止前端因读取不到 Cookiebot 变量而死锁/报错
    const injectedScripts = `
<script>
if("serviceWorker" in navigator){navigator.serviceWorker.getRegistrations().then(function(rs){for(let r of rs){r.unregister();console.log("[MirrorKit] Killed rogue Service Worker");}});}
window.Cookiebot = {
    consent: { marketing: true, statistics: true, preferences: true, necessity: true },
    show: function() {},
    hide: function() {},
    renew: function() {},
    runScripts: function() {}
};
</script>
</head>`;
    cleanText = cleanText.replace(/<\/head>/i, injectedScripts);

    // 动态拦截并修复 HLS 播放器 resolveUrl 相对路径基准 Bug
    let fixedText = cleanText.replace(
        'function resolveUrl(base, rel) { try { return new URL(rel, base).toString(); } catch(_) { return rel; } }',
        'function resolveUrl(base, rel) { try { var absoluteBase = (base && base.startsWith("/")) ? window.location.origin + base : base; return new URL(rel, absoluteBase).toString(); } catch(_) { return rel; } }'
    );

    // 动态拦截并修复 HLS 播放器 getSourceMeta 异步死锁 Bug
    fixedText = fixedText.replace(
        /function getSourceMeta\s*\(\s*src\s*,\s*useHlsJs\s*\)\s*\{\s*return\s+new\s+Promise\s*\(\s*function\s*\(\s*resolve\s*\)\s*\{/i,
        'function getSourceMeta(src, useHlsJs) { return new Promise(function(resolve) { var tId = setTimeout(function() { resolve({ width: 0, height: 0, duration: NaN }); }, 5000); var origRes = resolve; resolve = function(v) { clearTimeout(tId); origRes(v); };'
    );

    // 【Cuberto 专用终极防崩垫片】：修复 GSAP SVG getBBox 在大屏/Webgl环境下的 this.style is undefined 空指针导致主画布死锁崩溃问题
    fixedText = fixedText.replace(
        /i\.appendChild\(this\),this\.style\.display="block"/g,
        'i.appendChild(this); if(this.style) { this.style.display="block"; }'
    );

    const origin = getRequestOrigin(req);
    const originHost = new URL(origin).host;

    if (SERVE_AT_ROOT) {
        return rewriteExternalUrlsForLocalMirror(fixedText, req)
            .replaceAll(TARGET_HOST, `${origin}`)
            .replace(assetUrl, (match, host, assetPath) => {
                if (host.toLowerCase() === originHost.toLowerCase() || host.startsWith('localhost:') || host.startsWith('127.0.0.1:')) {
                    return match;
                }
                return `${origin}/${host}${assetPath}`;
            })
            .replace(rootAsset, (match, prefix, assetPath) => `${prefix}/${assetPath}`)
            .replace(rootRoute, (match, prefix, routePath) => `${prefix}/${routePath}`);
    }

    return rewriteExternalUrlsForLocalMirror(fixedText, req)
        .replaceAll(TARGET_HOST, `${origin}/${MIRROR_NAME}`)
        .replace(assetUrl, (match, host, assetPath) => {
            if (host.toLowerCase() === originHost.toLowerCase() || host.startsWith('localhost:') || host.startsWith('127.0.0.1:')) {
                return match;
            }
            return `${origin}/${MIRROR_NAME}/${host}${assetPath}`;
        })
        .replace(rootAsset, (match, prefix, assetPath) => `${prefix}/${MIRROR_NAME}/${assetPath}`)
        .replace(rootRoute, (match, prefix, routePath) => `${prefix}/${MIRROR_NAME}/${routePath}`);
}

async function fetchWithTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        return await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Referer: TARGET_HOST
            }
        });
    } finally {
        clearTimeout(timer);
    }
}

function getRemoteMirror(reqPath) {
    return [...REMOTE_MIRRORS, ...BUILTIN_REMOTE_MIRRORS].find(mirror => reqPath.startsWith(mirror.prefix));
}

function getGoogleStorageTargetUrl(reqPath, search) {
    const parts = reqPath.split('/').filter(Boolean);
    if (parts.length < 2) return null;

    if (parts[0] === 'storage.googleapis.com') {
        return `https://storage.googleapis.com/${parts.slice(1).join('/')}${search}`;
    }

    if (/^[a-z0-9-]+\.appspot\.com$/i.test(parts[0])) {
        return `https://storage.googleapis.com/${parts[0]}/${parts.slice(1).join('/')}${search}`;
    }

    return null;
}

// 根据请求路径生成真正要抓取的远程 URL。
function getTargetUrl(req, reqPath) {
    const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
    const targetPath = isMirrorRequest(reqPath) ? stripMirrorPrefix(reqPath) : reqPath;
    const mirror = getRemoteMirror(targetPath);

    if (mirror) {
        return `${mirror.origin}${targetPath.slice(mirror.prefix.length - 1)}${requestUrl.search}`;
    }

    const gcsUrl = getGoogleStorageTargetUrl(targetPath, requestUrl.search);
    if (gcsUrl) return gcsUrl;

    const parts = targetPath.split('/').filter(Boolean);
    if (parts.length > 1 && looksLikeMirroredRemoteHost(parts[0]) && !SITE_PATH_PREFIXES.has(parts[0])) {
        return `https://${parts[0]}/${parts.slice(1).join('/')}${requestUrl.search}`;
    }

    // 智能子路径映射：如果 TARGET_HOST 包含子路径（如 /en-sg/），而资源路径（targetPath）不以该子路径开头，
    // 说明它是网站根相对路径资源（如 Next.js 的 _next 资产），必须从源站 origin 抓取，否则会发生 404
    try {
        const parsedTarget = new URL(TARGET_HOST);
        const subpath = parsedTarget.pathname;
        if (subpath !== '/' && subpath !== '') {
            const cleanSubpath = subpath.endsWith('/') ? subpath.slice(0, -1) : subpath;
            const cleanTargetPath = targetPath.startsWith('/') ? targetPath : '/' + targetPath;
            if (!cleanTargetPath.startsWith(cleanSubpath + '/') && cleanTargetPath !== cleanSubpath) {
                return `${parsedTarget.origin}${cleanTargetPath}${requestUrl.search}`;
            }
        }
    } catch (e) {
        // 忽略解析错误
    }

    const baseHost = TARGET_HOST.endsWith('/') ? TARGET_HOST.slice(0, -1) : TARGET_HOST;
    const cleanPath = targetPath.startsWith('/') ? targetPath : '/' + targetPath;
    return `${baseHost}${cleanPath}${requestUrl.search}`;
}

async function proxyAndCache(req, res, localPath, reqPath) {
    const targetUrl = getTargetUrl(req, reqPath);
    console.log(`\x1b[33m[Cache Miss] ${req.url} -> ${targetUrl}\x1b[0m`);

    try {
        const response = await fetchWithTimeout(targetUrl);

        if (!response.ok) {
            console.error(`\x1b[31m[Failed] Origin status ${response.status}: ${req.url}\x1b[0m`);
            res.writeHead(response.status, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Origin responded with status: ${response.status}`);
            return;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (!isValidCachedResponse(localPath, response, buffer)) {
            const contentType = response.headers.get('content-type') || 'unknown';
            console.error(`\x1b[31m[Rejected] Not caching unexpected content for ${req.url} (${contentType})\x1b[0m`);
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Rejected unexpected content for ${req.url}`);
            return;
        }

        ensureDirExists(localPath);
        fs.writeFileSync(localPath, buffer);
        console.log(`\x1b[32m[Saved] ${localPath}\x1b[0m`);

        let responseData = buffer;
        const ext = path.extname(localPath).toLowerCase();
        // 如果没有扩展名，只有在内容本身是 HTML-like 文本时才进行文本重写，防止误改 extensionless 的二进制字体文件
        if (REWRITE_TEXT_EXTS.has(ext) || (ext === '' && isHtmlLike(buffer))) {
            responseData = Buffer.from(rewriteTextForLocalMirror(buffer.toString('utf8'), req));
        } else if (EXTERNAL_URL_REWRITE_TEXT_EXTS.has(ext)) {
            responseData = Buffer.from(rewriteExternalUrlsForLocalMirror(buffer.toString('utf8'), req));
        }

        res.writeHead(200, {
            'Content-Type': getContentType(localPath, responseData),
            'Access-Control-Allow-Origin': '*'
        });
        res.end(responseData);
    } catch (err) {
        const status = err.name === 'AbortError' ? 504 : 500;
        console.error(`\x1b[31m[Error] ${req.url}: ${err.message}\x1b[0m`);
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Proxy error: ${err.message}`);
    }
}

const server = http.createServer(async (req, res) => {
    if (req.url === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad request');
        return;
    }

    // 外层 / 永远打开框架说明页。
    // 目标站点入口请访问 /MIRROR_NAME/START_PATH，例如 /example.com/。
    const reqPath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;

    // 给外层 index.html 用的运行时配置。
    // 这样启动页不用写死 /example.com/，会自动读取当前 server.js 顶部配置。
    if (reqPath === '/__mirror-config.json') {
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
            targetHost: TARGET_HOST,
            mirrorName: MIRROR_NAME,
            startPath: START_PATH,
            entryPath: getMirrorEntryPath()
        }));
        return;
    }

    if (reqPath === '/index.html') {
        if (!SERVE_AT_ROOT) {
            serveStarterPage(res);
            return;
        }
    }

    if (IGNORED_PATH_PREFIXES.some(prefix => reqPath === prefix || reqPath.startsWith(prefix))) {
        res.writeHead(204);
        res.end();
        return;
    }

    const localPath = getLocalPath(reqPath);
    if (!localPath) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
    }

    if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
        serveLocalFile(localPath, res, req);
        return;
    }

    if (OFFLINE_MODE) {
        console.log(`\x1b[90m[Offline] Not found locally, skipping remote fetch: ${req.url}\x1b[0m`);
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Offline mode: resource not cached locally');
        return;
    }

    await proxyAndCache(req, res, localPath, reqPath);
});

server.listen(PORT, () => {
    console.log('\n==========================================================');
    console.log('\x1b[36m  Offline Mirror - Local Proxy & Crawler Server\x1b[0m');
    console.log('==========================================================');
    console.log(`Target host: \x1b[32m${TARGET_HOST}\x1b[0m`);
    console.log(`Mirror folder: \x1b[32m${MIRROR_NAME}\x1b[0m`);
    console.log(`Local starter: \x1b[32mhttp://localhost:${PORT}/\x1b[0m`);
    console.log(`Mirror entry: \x1b[32mhttp://localhost:${PORT}${getMirrorEntryPath()}\x1b[0m`);
    console.log(`Request timeout: ${REQUEST_TIMEOUT_MS}ms`);
    console.log(`Offline mode: ${OFFLINE_MODE ? '\x1b[33mENABLED (no remote fetch)\x1b[0m' : 'disabled (proxy & cache)'}`);
    console.log('Unexpected HTML fallback responses will not be cached as assets.');
    console.log('----------------------------------------------------------\n');

    const url = `http://localhost:${PORT}/`;
    const startCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${startCmd} ${url}`, (err) => {
        if (err) console.error('Failed to auto-open browser:', err.message);
    });
});
