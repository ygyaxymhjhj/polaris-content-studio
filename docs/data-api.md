# VN-AI V1 数据结构与接口草案

## 1. 核心实体关系

```text
ContentProject
  └── SourceArticle
        └── FactItem
  └── ContentAsset
        └── ReviewRecord
  └── PushCampaign
  └── ExportRecord
```

## 2. ContentProject

```json
{
  "id": "project_001",
  "name": "New Gold Regulation",
  "language": "en",
  "category": "gold",
  "targetAudience": ["traders", "broker_users"],
  "primaryCta": "read_article",
  "websiteUrl": null,
  "status": "fact_review",
  "createdBy": "user_001",
  "createdAt": "2025-01-01T10:00:00Z",
  "updatedAt": "2025-01-01T10:00:00Z"
}
```

## 3. SourceArticle

```json
{
  "id": "article_001",
  "projectId": "project_001",
  "title": "New Gold Regulation",
  "body": "...",
  "inputType": "docx",
  "sourceFileName": "article.docx",
  "sourceLinks": [],
  "plannedWebsiteUrl": null,
  "publishDate": null,
  "riskLevel": "high",
  "wordCount": 1200
}
```

## 4. FactItem

```json
{
  "id": "fact_001",
  "articleId": "article_001",
  "type": "date",
  "text": "The regulation takes effect on ...",
  "sourceExcerpt": "...",
  "sourceLocation": {
    "paragraph": 5
  },
  "sourceUrl": "https://example.com/source",
  "verified": false,
  "usableOnSocial": true,
  "riskLevel": "medium",
  "reviewComment": null
}
```

## 5. ContentAsset

```json
{
  "id": "asset_001",
  "projectId": "project_001",
  "platform": "facebook",
  "assetType": "short_post",
  "variant": "A",
  "title": "A new gold regulation may affect traders",
  "content": "...",
  "hook": "...",
  "cta": "Read the full explanation",
  "deepLink": null,
  "factIds": ["fact_001", "fact_002"],
  "visualBrief": "...",
  "riskFlags": [],
  "status": "needs_review",
  "version": 1
}
```

## 6. ReviewRecord

```json
{
  "id": "review_001",
  "assetId": "asset_001",
  "reviewerId": "user_002",
  "action": "rejected",
  "comment": "Please remove the unsupported claim in paragraph two.",
  "createdAt": "2025-01-01T12:00:00Z"
}
```

## 7. PushCampaign

```json
{
  "id": "push_001",
  "projectId": "project_001",
  "audienceRule": {
    "interests": ["gold"],
    "readArticleInLastDays": 30
  },
  "sendWindow": {
    "timezone": "Asia/Ho_Chi_Minh",
    "start": "18:00",
    "end": "21:00"
  },
  "frequencyLimit": "1_per_24_hours",
  "variants": ["asset_010", "asset_011", "asset_012"],
  "deepLink": "app://article/article_001",
  "status": "draft"
}
```

## 8. 推荐接口

### 项目

```http
POST /api/projects
GET /api/projects
GET /api/projects/:id
PATCH /api/projects/:id
```

### 文章

```http
POST /api/projects/:id/source-article
POST /api/projects/:id/source-article/parse
GET /api/projects/:id/source-article
POST /api/fetch-article
```

`POST /api/fetch-article` 请求：

```json
{
  "url": "https://example.com/article"
}
```

返回标题、正文、canonical URL、字数和截断状态。仅允许公开的 HTTP/HTTPS HTML 页面；本地地址、内网地址和带账号密码的 URL 会被拒绝。

### 事实包

```http
GET /api/projects/:id/facts
PATCH /api/facts/:id
POST /api/projects/:id/facts/approve
```

### 内容生成

```http
POST /api/projects/:id/generate
POST /api/projects/:id/generate/:platform
POST /api/assets/:id/regenerate
```

请求示例：

```json
{
  "platforms": [
    "website",
    "facebook",
    "threads",
    "linkedin",
    "x",
    "instagram",
    "short_video",
    "community",
    "push",
    "kol_live",
    "faq"
  ],
  "tone": "clear_professional",
  "language": "en"
}
```

### 审核

```http
PATCH /api/assets/:id
POST /api/assets/:id/submit-review
POST /api/assets/:id/approve
POST /api/assets/:id/reject
GET /api/assets/:id/reviews
```

### 导出

```http
POST /api/projects/:id/exports
GET /api/projects/:id/exports/:exportId
```

## 9. AI 服务内部流程

```text
parseDocument()
→ extractFacts()
→ validateFacts()
→ generateAssets(platform, facts, brandRules)
→ validateAssetAgainstFacts()
→ detectRisk()
→ detectDuplicateAngle()
→ saveAsset()
```

所有生成接口必须返回结构化 JSON，并保存：

- 使用的 Fact IDs
- 使用的提示词版本
- 模型版本
- 生成时间
- 风险检查结果

## 10. 第二阶段预留

- CMS 自动发布接口
- Facebook/LinkedIn/X 等平台发布接口
- Firebase 或 OneSignal Push 接口
- 用户行为事件表
- 自动用户分群
- A/B 测试结果
- 曝光、点击、转化数据导入
- 基于效果的 Hook、CTA 和发布时间优化
