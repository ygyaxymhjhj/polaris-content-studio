# 文章链接爬虫

## 适用场景

V1 支持两种 URL 抓取方式：

1. 工具页面中的 `Fetch article`：服务端直接抓取公开 HTML 页面。
2. 浏览器型爬虫：用于需要 JavaScript 渲染的页面，或需要人工完成验证的页面。

爬虫不会绕过 CAPTCHA、滑块验证或登录权限。

## 命令

首次安装浏览器运行环境：

```bash
npx playwright install chromium
```

抓取公开页面：

```bash
npm run crawl:article -- "https://example.com/article" --headless --output=article.json
```

抓取遇到人工验证的页面：

```bash
npm run crawl:article -- "https://example.com/article" --output=article.json
```

默认会打开可见浏览器。请在浏览器中完成网站要求的人工验证，完成后爬虫会自动检测页面并提取正文，最多等待 120 秒。

## 输出

```json
{
  "title": "Article title",
  "text": "Article body...",
  "canonical": "https://example.com/article",
  "sourceUrl": "https://example.com/article",
  "wordCount": 1200,
  "truncated": false,
  "fetchedAt": "2025-01-01T10:00:00.000Z",
  "crawlerMode": "playwright"
}
```

生成的 JSON 可以直接在工具首页作为 `Crawler JSON` 上传，然后进入事实审核流程。

## 本次 WikiFXTips 链接测试结果

```text
https://www.wikifxtips.com/vi/newsdetail/202609079764964517.html
```

该页面返回阿里云 WAF 滑块验证页面。无头模式会安全退出并提示人工验证；可见模式可以打开页面，但需要人工完成滑块后才能继续提取正文。
