try {
    const { setGlobalDispatcher, ProxyAgent } = require('undici');
    
    if (process.env.HTTP_PROXY) {
        console.log(`\n\x1b[36m[ProxyBootstrap] 🚀 自动拦截全局网络请求，正将其导向代理端口: ${process.env.HTTP_PROXY}\x1b[0m\n`);
        
        // 设置全局 fetch 请求代理分发器
        setGlobalDispatcher(new ProxyAgent(process.env.HTTP_PROXY));
    }
} catch (err) {
    // 捕获异常防止非 Node.js 运行异常中断
    console.error('\x1b[31m[ProxyBootstrap] 载入内置代理引擎失败:\x1b[0m', err.message);
}
