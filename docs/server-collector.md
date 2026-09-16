# 统一服务端文章采集（内测）

入口保持 POST /api/fetch-article，编辑只需输入文章 URL。当前为候选实现，通过 ARTICLE_COLLECTOR_V2=true 启用，尚未作为生产抓取问题的解决方案发布。

1. 校验公开 HTTP/HTTPS 地址，仅允许标准端口，DNS 解析后固定连接到已检查的公网 IP；每次重定向重新检查。
2. 直接下载 HTML，识别 WikiFX 正文区域与通用文章区域，保留短标题和短事实。
3. 仅当公开页面 HTTP 200、未触发访问限制、但正文不足时，尝试无头 Chrome 渲染。
4. 浏览器所有 HTTP 请求经相同的安全下载器；不传用户 Cookie、不加载服务工作线程，阻止 WebSocket/非 GET 和图片视频资源，并限制请求数、体积与等待时间。
5. 401/403/验证码明确停止；不换出口、不使用代理轮换、不自动解验证码。429 暂停。
6. 单进程最多 2 个并发采集、10 个在途任务；相同 URL 合并；成功缓存 10 分钟，拒绝访问/限流冷却 1 分钟，最多 30 个缓存条目。
7. 输出 collectionMode、cached、fetchedAt，供诊断。缓存与任务队列目前在进程内，不是多实例共享，也不会在重启后保留。

服务器实测：MDN JavaScript 文章成功返回 5,170 字符；WikiFX 202609146954444618 仍返回 SOURCE_ACCESS_DENIED（403）。本地 DNS 返回 198.18.0.189（虚拟 DNS/Fake-IP 地址），服务器返回公网地址，说明网络链路不一致；没有读取或复制本地代理凭据，没有改变服务器出口。新安全采集器默认拒绝保留地址，因此保持本地原流程不受影响，待目标站验收后再切换。

配置：
- ARTICLE_COLLECTOR_V2=true：启用候选采集服务；未设置时保留原抓取流程。
- ARTICLE_RENDER_BROWSER=true：启用公开动态页面渲染。
- ARTICLE_BROWSER_EXECUTABLE=/usr/bin/google-chrome：服务器已有 Chrome 路径。本地留空使用 Playwright 已安装的 Chromium。
- ARTICLE_CRAWLER_LOCAL_BROWSER=false：继续关闭旧的交互式爬虫。

无需新增公共代理接口。这个采集器不会消除网站明确的访问拒绝；真实 WikiFX 链路必须独立验收，不能用其他网站成功代替。

测试：node scripts/test-article-collector.mjs。测试使用模拟公网响应和真实 Chromium，不调用付费 AI，也不访问受保护网站。
