const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

const PORT = 4000;
const PRESETS_FILE = path.join(__dirname, 'presets.json');
const UI_FILE = path.join(__dirname, 'launcher-ui.html');
const MIRROR_KIT_DIR = path.resolve(__dirname, '../MirrorKit');

// 全局进程引用
let activeServerProcess = null;
let activeServerPresetId = null;

let activeDownloaderProcess = null;
let activeDownloaderPresetId = null;
let activeDownloaderScriptType = null; // 'assets' 或 'cms'

// SSE 客户端列表，用于推流日志
let sseClients = [];

// ================= 日志广播系统 =================

function broadcastLog(message) {
    if (!message) return;
    const lines = String(message).split(/\r?\n/);
    lines.forEach(line => {
        // 过滤空行，控制台输出格式美化
        const trimmed = line.trim();
        if (!trimmed) return;
        
        // 输出到控制台服务端的终端，方便观察
        console.log(`[LogStream] ${trimmed}`);
        
        // 推送到所有连接的 SSE 前端页面
        sseClients.forEach(client => {
            try {
                client.write(`data: ${trimmed}\n\n`);
            } catch (err) {
                // 忽略发送失败的客户端
            }
        });
    });
}

// ================= 跨平台进程终止辅助函数 =================

function killProcess(processInstance, callback) {
    if (!processInstance) {
        if (callback) callback();
        return;
    }

    const pid = processInstance.pid;
    if (process.platform === 'win32') {
        // Windows 下使用 taskkill 强行终止进程及其子进程树，防止端口残留
        exec(`taskkill /pid ${pid} /f /t`, (err) => {
            if (err) {
                console.error(`Taskkill failed for PID ${pid}:`, err.message);
                // 兜底调用普通的 kill
                try { processInstance.kill('SIGKILL'); } catch (e) {}
            }
            if (callback) callback();
        });
    } else {
        processInstance.kill('SIGTERM');
        if (callback) callback();
    }
}

// ================= 辅助函数：解析请求体 JSON =================

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (err) {
                reject(err);
            }
        });
    });
}

// ================= 辅助函数：扫描本地实际存在文件夹 =================

function scanLocalFolders() {
    if (!fs.existsSync(MIRROR_KIT_DIR)) {
        return [];
    }
    try {
        const exclude = new Set(['.git', 'tools', 'node_modules', 'MirrorLauncher']);
        return fs.readdirSync(MIRROR_KIT_DIR, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name)
            .filter(name => !exclude.has(name) && fs.existsSync(path.join(MIRROR_KIT_DIR, name, 'index.html')));
    } catch (err) {
        console.error('Scanning local folders failed:', err.message);
        return [];
    }
}

// ================= 路由处理器 =================

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // 跨域支持 (为调试和本地面板提供便利)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 1. 静态主页渲染
    if ((pathname === '/' || pathname === '/index.html') && req.method === 'GET') {
        fs.readFile(UI_FILE, 'utf8', (err, html) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(`Internal Server Error: ${err.message}`);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        });
        return;
    }

    // 2. SSE 日志推流接口
    if (pathname === '/api/downloader/logs' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        // 保持心跳连接
        res.write('data: [SSE] Connected to log terminal stream.\n\n');
        sseClients.push(res);

        req.on('close', () => {
            sseClients = sseClients.filter(client => client !== res);
        });
        return;
    }

    // 3. API: 获取站点预设（混合本地文件夹扫描）
    if (pathname === '/api/presets' && req.method === 'GET') {
        let presets = [];
        if (fs.existsSync(PRESETS_FILE)) {
            try {
                presets = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
            } catch (err) {
                presets = [];
            }
        }

        // 扫描本地已经下载的镜像文件夹
        const downloadedFolders = new Set(scanLocalFolders());

        // 注入是否存在本地的标识
        const enrichedPresets = presets.map(preset => {
            return {
                ...preset,
                existsLocally: downloadedFolders.has(preset.mirrorName)
            };
        });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(enrichedPresets));
        return;
    }

    // 4. API: 新增或修改站点预设
    if (pathname === '/api/presets' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            let presets = [];
            if (fs.existsSync(PRESETS_FILE)) {
                try {
                    presets = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
                } catch (e) { presets = []; }
            }

            const idx = presets.findIndex(p => p.id === data.id);
            if (idx !== -1) {
                // 更新已存在
                presets[idx] = data;
                broadcastLog(`[SYSTEM] 预设更新: ${data.name} (${data.targetHost})`);
            } else {
                // 添加新预设
                presets.push(data);
                broadcastLog(`[SYSTEM] 创建新预设: ${data.name} (${data.targetHost})`);
            }

            fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2), 'utf8');

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, message: 'Preset saved successfully' }));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
    }

    // 5. API: 删除站点预设
    if (pathname === '/api/presets' && req.method === 'DELETE') {
        const deleteId = url.searchParams.get('id');
        if (!deleteId) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: 'Missing parameter "id"' }));
            return;
        }

        try {
            let presets = [];
            if (fs.existsSync(PRESETS_FILE)) {
                presets = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
            }

            const targetPreset = presets.find(p => p.id === deleteId);
            const filtered = presets.filter(p => p.id !== deleteId);
            fs.writeFileSync(PRESETS_FILE, JSON.stringify(filtered, null, 2), 'utf8');

            if (targetPreset) {
                broadcastLog(`[SYSTEM] 删除预设: ${targetPreset.name}`);
            }

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, message: 'Preset deleted successfully' }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
    }

    // 6. API: 获取服务器状态
    if (pathname === '/api/server/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            running: activeServerProcess !== null,
            activePresetId: activeServerPresetId
        }));
        return;
    }

    // 7. API: 启动代理服务器 (server.js)
    if (pathname === '/api/server/start' && req.method === 'POST') {
        try {
            const data = await readJsonBody(req);
            let presets = [];
            if (fs.existsSync(PRESETS_FILE)) {
                presets = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
            }
            const preset = presets.find(p => p.id === data.id);

            if (!preset) {
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, message: 'Preset not found' }));
                return;
            }

            // 执行启动流程：如果已有服务器在运行，先强杀
            const runStartup = () => {
                broadcastLog(`[SYSTEM] 正在启动站点 [${preset.name}] 的镜像服务器进程...`);

                // 准备动态环境变量，继承父进程环境变量并重写核心字段
                const spawnEnv = {
                    ...process.env,
                    PORT: '3000',
                    TARGET_HOST: preset.targetHost,
                    MIRROR_NAME: preset.mirrorName,
                    START_PATH: preset.startPath
                };

                // 纯离线模式：禁止 server.js 向远程拉取资源
                if (data.offlineMode) {
                    spawnEnv.OFFLINE_MODE = '1';
                }

                // 准备参数列表
                const nodeArgs = [];

                // 如果启用了网络代理，注入代理环境变量，并预加载代理拦截脚本
                if (preset.useProxy && preset.proxyAddress) {
                    spawnEnv.HTTP_PROXY = preset.proxyAddress;
                    spawnEnv.HTTPS_PROXY = preset.proxyAddress;
                    spawnEnv.NODE_TLS_REJECT_UNAUTHORIZED = '0';
                    spawnEnv.NODE_USE_ENV_PROXY = '1'; // 兼容较新版本的 Node.js
                    nodeArgs.push('-r', '../MirrorLauncher/proxy-bootstrap.js');
                }
                nodeArgs.push('server.js');

                // 在 MirrorKit 目录下运行 node server.js (包含预加载)
                activeServerProcess = spawn('node', nodeArgs, {
                    cwd: MIRROR_KIT_DIR,
                    env: spawnEnv
                });
                activeServerPresetId = preset.id;

                broadcastLog(`[SYSTEM] 服务器进程 PID: ${activeServerProcess.pid} 成功在后台开启。`);

                // 捕获并推流输出日志
                activeServerProcess.stdout.on('data', (chunk) => {
                    broadcastLog(chunk.toString());
                });

                activeServerProcess.stderr.on('data', (chunk) => {
                    broadcastLog(`[Server Error] ${chunk.toString()}`);
                });

                activeServerProcess.on('close', (code) => {
                    broadcastLog(`[SYSTEM] 服务器进程 PID: ${activeServerProcess ? activeServerProcess.pid : 'unknown'} 已退出，退出码: ${code}`);
                    activeServerProcess = null;
                    activeServerPresetId = null;
                });

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, message: `Server successfully started on http://localhost:3000/${preset.mirrorName}` }));
            };

            if (activeServerProcess) {
                broadcastLog('[SYSTEM] 检测到有正在运行的服务器，正在终止旧的服务器进程...');
                killProcess(activeServerProcess, () => {
                    activeServerProcess = null;
                    activeServerPresetId = null;
                    // 给系统 300ms 释放端口的时间
                    setTimeout(runStartup, 300);
                });
            } else {
                runStartup();
            }

        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
    }

    // 8. API: 停止代理服务器 (server.js)
    if (pathname === '/api/server/stop' && req.method === 'POST') {
        if (!activeServerProcess) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: 'Server is not running' }));
            return;
        }

        broadcastLog('[SYSTEM] 收到指令，正在终止本地镜像服务器进程...');
        killProcess(activeServerProcess, () => {
            activeServerProcess = null;
            activeServerPresetId = null;
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, message: 'Server successfully stopped' }));
        });
        return;
    }

    // 9. API: 获取下载器状态
    if (pathname === '/api/downloader/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            running: activeDownloaderProcess !== null,
            activePresetId: activeDownloaderPresetId,
            scriptType: activeDownloaderScriptType
        }));
        return;
    }

    // 10. API: 启动资源下载任务 (mirror-assets.js 或 mirror-cms-media.js)
    if (pathname === '/api/downloader/start' && req.method === 'POST') {
        if (activeDownloaderProcess) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: 'Another downloader is already running' }));
            return;
        }

        try {
            const data = await readJsonBody(req);
            let presets = [];
            if (fs.existsSync(PRESETS_FILE)) {
                presets = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
            }
            const preset = presets.find(p => p.id === data.id);

            if (!preset) {
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, message: 'Preset not found' }));
                return;
            }

            const scriptType = data.scriptType || 'assets';
            const scriptName = scriptType === 'assets' ? 'mirror-assets.js' : 'mirror-cms-media.js';
            const scriptPath = path.join('tools', scriptName);

            broadcastLog(`[SYSTEM] ==========================================================`);
            broadcastLog(`[SYSTEM] 启动批量下载器：${scriptName}`);
            broadcastLog(`[SYSTEM] 目标域名 TARGET_HOST: ${preset.targetHost}`);
            broadcastLog(`[SYSTEM] 本地文件夹 MIRROR_NAME: ${preset.mirrorName}`);
            broadcastLog(`[SYSTEM] 入口路径 START_PATH: ${preset.startPath}`);
            broadcastLog(`[SYSTEM] ==========================================================`);

            const spawnEnv = {
                ...process.env,
                TARGET_HOST: preset.targetHost,
                MIRROR_NAME: preset.mirrorName,
                START_PATH: preset.startPath
            };

            // 准备参数列表
            const nodeArgs = [];

            // 如果启用了网络代理，注入代理环境变量，并预加载代理拦截脚本
            if (preset.useProxy && preset.proxyAddress) {
                spawnEnv.HTTP_PROXY = preset.proxyAddress;
                spawnEnv.HTTPS_PROXY = preset.proxyAddress;
                spawnEnv.NODE_TLS_REJECT_UNAUTHORIZED = '0';
                spawnEnv.NODE_USE_ENV_PROXY = '1'; // 兼容较新版本的 Node.js
                nodeArgs.push('-r', '../MirrorLauncher/proxy-bootstrap.js');
            }
            
            nodeArgs.push(scriptPath);
            if (data.retryBad) {
                nodeArgs.push('--retry-bad');
            }

            activeDownloaderProcess = spawn('node', nodeArgs, {
                cwd: MIRROR_KIT_DIR,
                env: spawnEnv
            });
            activeDownloaderPresetId = preset.id;
            activeDownloaderScriptType = scriptType;

            // 监听下载子进程输出日志并广播到前端 terminal
            activeDownloaderProcess.stdout.on('data', (chunk) => {
                broadcastLog(chunk.toString());
            });

            activeDownloaderProcess.stderr.on('data', (chunk) => {
                broadcastLog(`[Downloader Error] ${chunk.toString()}`);
            });

            activeDownloaderProcess.on('close', (code) => {
                broadcastLog(`[SYSTEM] 批量下载任务执行完毕，退出码: ${code}`);
                activeDownloaderProcess = null;
                activeDownloaderPresetId = null;
                activeDownloaderScriptType = null;
            });

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, message: `Downloader script ${scriptName} started successfully` }));

        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
    }

    // 11. API: 终止资源下载任务
    if (pathname === '/api/downloader/stop' && req.method === 'POST') {
        if (!activeDownloaderProcess) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: 'Downloader is not running' }));
            return;
        }

        broadcastLog('[SYSTEM] 收到指令，正在强制终止下载任务...');
        killProcess(activeDownloaderProcess, () => {
            activeDownloaderProcess = null;
            activeDownloaderPresetId = null;
            activeDownloaderScriptType = null;
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, message: 'Downloader script aborted successfully' }));
        });
        return;
    }

    // 12. 路由未匹配兜底
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
});

// ================= 服务进程生命周期管理 =================

// 当控制面板服务关闭时，主动杀掉它拉起的所有 server 代理和下载子进程，防止死锁
function cleanupProcesses() {
    console.log('\nCleaning up active subprocesses before exiting...');
    if (activeServerProcess) {
        try { activeServerProcess.kill(); } catch (e) {}
    }
    if (activeDownloaderProcess) {
        try { activeDownloaderProcess.kill(); } catch (e) {}
    }
    process.exit();
}

process.on('SIGINT', cleanupProcesses);
process.on('SIGTERM', cleanupProcesses);
process.on('exit', cleanupProcesses);

// 启动服务器
server.listen(PORT, () => {
    console.log('\n==========================================================');
    console.log('🔮  MirrorHub Control Panel Server is now online!');
    console.log(`🌍  Dashboard Address: http://localhost:${PORT}/`);
    console.log('==========================================================\n');
    
    // 自动在默认浏览器中打开控制面板
    const url = `http://localhost:${PORT}/`;
    const startCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${startCmd} ${url}`, (err) => {
        if (err) console.error('Failed to auto-open browser for dashboard:', err.message);
    });
});
