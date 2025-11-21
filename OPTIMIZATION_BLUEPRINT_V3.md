# AI-Nexus V3.0 架构优化与部署执行手册

**版本**: 3.0
**目标**: 打造零成本、稳定、安全、流畅的权威 AI 模型聚合平台
**核心原则**:
- **零成本**: 仅使用 Cloudflare Free Tier 和 GitHub Free Tier。
- **无第三方依赖**: 拒绝任何需要付费或可能导致数据锁定的外部 SaaS 服务 (如 Clerk, Vercel KV 等)。
- **数据资产化**: 所有数据归属于 D1，所有代码归属于 GitHub。
- **流量自动化**: SEO 与社交分享全自动运行。

---

## 1. 核心技术架构 (The Zero-Cost Stack)

本项目完全基于 **Cloudflare Free Tier** 生态构建，确保在日均 10 万 PV 级别下的零成本运营。

| 模块 | 技术选型 | 职责描述 | 免费额度/优势 |
| :--- | :--- | :--- | :--- |
| **前端托管** | **Cloudflare Pages** | 托管 Astro 生成的静态资源 (SSG) 及边缘函数。 | 无限带宽/请求。 |
| **核心数据库** | **Cloudflare D1** | 存储模型元数据、分类、标签、评分。替代 JSON 文件。 | 500万读/天，10万写/天。 |
| **缓存/热数据** | **Cloudflare KV** | 缓存热门排行榜、API 响应结果。 | 低延迟，减轻 D1 压力。 |
| **搜索/API** | **Pages Functions** | 处理搜索请求、动态数据查询。 | 运行在边缘节点，极速响应。 |
| **评论系统** | **自建 (D1 + Auth.js)** | 深度集成的原生评论系统。 | 统一账户体系，数据完全私有。 |
| **用户认证** | **Auth.js (NextAuth)** | 基于 D1 的自建认证系统 (Google/GitHub)。 | **完全免费**，数据完全私有，无 MAU 限制。 |
| **图片存储** | **Cloudflare R2** | (可选) 存储模型封面/截图。 | 避免源站防盗链，10GB 免费。 |
| **自动化运维** | **GitHub Actions** | 运行数据抓取脚本、备份任务。 | 2000分钟/月。 |
| **数据备份** | **R2 + GitHub** | D1 数据库定期导出快照。 | 双重保险，极低成本。 |

---

## 2. 数据库设计 (D1 Schema)

数据是核心资产。设计遵循“以 ID 为锚，只增不减”的原则。

### 2.1 表结构设计

**Table: `models` (核心资产表)**
```sql
CREATE TABLE models (
    id TEXT PRIMARY KEY,          -- 唯一标识 (如 "meta-llama/Llama-3-8B")，永不改变
    name TEXT NOT NULL,           -- 模型名称
    author TEXT NOT NULL,         -- 作者/组织
    description TEXT,             -- 描述 (Markdown/Text)
    tags TEXT,                    -- JSON 字符串存储标签数组
    pipeline_tag TEXT,            -- 核心任务类型 (如 text-generation)
    likes INTEGER DEFAULT 0,      -- 点赞数 (源站 + 本地)
    downloads INTEGER DEFAULT 0,  -- 下载量
    created_at DATETIME,          -- 源站发布时间
    last_updated DATETIME,        -- 本地最后更新时间
    first_indexed DATETIME,       -- 本站首次收录时间 (用于生成"经典榜")
    link_status TEXT DEFAULT 'ok',-- 链接状态 ('ok', 'broken')
    source_url TEXT               -- 源站链接
);
```

**Table: `keywords` (动态流量表)**
```sql
CREATE TABLE keywords (
    slug TEXT PRIMARY KEY,        -- URL slug (如 "text-to-video")
    title TEXT NOT NULL,          -- 显示标题
    parent_category TEXT,         -- 归属的 29 个固定分类之一
    description TEXT,             -- AI 生成的简介
    is_trending BOOLEAN DEFAULT 0,-- 是否为飙升话题
    updated_at DATETIME           -- 最后更新时间
);
```

**Table: `user_interactions` (社区互动表)**
```sql
CREATE TABLE user_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT,
    action_type TEXT,             -- 'like', 'star', 'report_broken'
    ip_hash TEXT,                 -- 简单的防刷机制
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

**Table: `users` (Auth.js 核心表)**
```sql
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT UNIQUE,
    emailVerified DATETIME,
    image TEXT
);
```

**Table: `accounts` (Auth.js 第三方登录关联表)**
```sql
CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    type TEXT NOT NULL,
    provider TEXT NOT NULL,
    providerAccountId TEXT NOT NULL,
    refresh_token TEXT,
    access_token TEXT,
    expires_at INTEGER,
    token_type TEXT,
    scope TEXT,
    id_token TEXT,
    session_state TEXT,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
```

**Table: `sessions` (Auth.js 会话表)**
```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    sessionToken TEXT UNIQUE NOT NULL,
    userId TEXT NOT NULL,
    expires DATETIME NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
```

**Table: `verification_tokens` (Auth.js 验证表 - 仅用于邮箱登录，可留空)**
```sql
CREATE TABLE verification_tokens (
    identifier TEXT NOT NULL,
    token TEXT NOT NULL,
    expires DATETIME NOT NULL,
    PRIMARY KEY (identifier, token)
);
```

**Table: `user_favorites` (用户收藏表)**
```sql
CREATE TABLE user_favorites (
    user_id TEXT,
    model_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, model_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

**Table: `comments` (自建评论表)**
```sql
CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL,       -- 关联模型 ID
    user_id TEXT NOT NULL,        -- 关联用户 ID
    content TEXT NOT NULL,        -- 评论内容 (支持 Markdown)
    parent_id INTEGER,            -- 支持楼中楼回复
    likes INTEGER DEFAULT 0,      -- 评论点赞数
    is_hidden BOOLEAN DEFAULT 0,  -- 软删除/审核隐藏
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

**Table: `pending_models` (用户提交审核表)**
```sql
CREATE TABLE pending_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,                 -- 提交者
    url TEXT NOT NULL,            -- 模型链接
    status TEXT DEFAULT 'pending',-- 'pending', 'approved', 'rejected'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

**Table: `system_settings` (动态配置表)**
```sql
CREATE TABLE system_settings (
    key TEXT PRIMARY KEY,         -- 如 'ad_enabled', 'announcement_bar'
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
```
```

---

## 3. 数据管道改造 (Data Pipeline)

改造 `scripts/fetch-data.js`，使其成为智能的数据同步引擎。

### 3.1 更新逻辑 (Upsert Strategy)
1.  **抓取**: 从 Hugging Face / GitHub API 获取数据。
2.  **清洗**: 规范化标签，映射到 29 个固定分类。
3.  **同步**:
    *   **新模型**: 执行 `INSERT`。
    *   **旧模型**: 执行 `UPDATE` (仅更新 `likes`, `downloads`, `last_updated`, `description`)。
    *   **消失模型**: **不做任何操作**。保留在数据库中，确保 URL 永久有效。

### 3.3 图片资源本地化 (Image Handling)
*   **痛点**: 直接引用 GitHub/HF 图片可能遭遇防盗链 (403) 或加载缓慢。
*   **方案**:
    1.  `fetch-data.js` 检测到新模型时，下载其封面图。
    2.  使用 Cloudflare R2 API 上传图片。
    3.  D1 中存储 R2 的公开链接 (如 `https://img.free2aitools.com/llama-3.jpg`)。
    4.  **零成本**: R2 免费额度包含 10GB 存储和 1000万次读/月，完全足够。

### 3.4 性能优化策略 (Performance Strategy)
*   **图片处理 (Image Pre-processing)**:
    *   **策略**: **预处理 (Pre-processing)**。坚决不使用 Worker 实时处理。
    *   **实现**: 在 GitHub Actions 抓取阶段，使用脚本 (Sharp/Photon) 将图片压缩为 WebP 并裁剪，直接上传处理后的静态文件到 R2。
    *   **优势**: 用户下载极快，且不消耗 Worker CPU 时间，**零成本**。
*   **搜索架构 (Search Architecture)**:
    *   **阶段一**: **D1 SQL 搜索**。利用 SQLite 的 FTS (全文检索) 或 `LIKE` 查询。对于 10万级数据，响应通常在 100ms 以内，完全够用且免费。
    *   **阶段二 (升级预案)**: 当数据量巨大导致 D1 搜索 > 500ms 时，引入 **Rust (WASM)** 内存搜索引擎，并升级 Workers Paid Plan ($5/月)。这是平滑的后端升级，不影响前端。

### 3.5 数据抓取稳定性 (Proxy Strategy)
*   **风险**: GitHub Actions IP 可能被 Hugging Face 限流或屏蔽。
*   **方案**:
    *   **优先**: 使用 GitHub Actions 直连。
    *   **备选**: 如果出现 403 错误，自动切换至 **Cloudflare Worker 代理** (`worker.free2aitools.com/fetch`) 进行请求。Worker IP 信誉度高且分布广泛。

### 3.5 数据库变更规范 (Migration Protocol)
*   **风险**: 直接在生产环境修改 D1 表结构可能导致数据丢失。
*   **规范**:
    1.  所有 Schema 变更必须编写 SQL 文件存入 `migrations/` 目录 (如 `0001_init.sql`)。
    2.  必须先在本地 (`wrangler d1 execute --local`) 测试通过。
    3.  生产环境变更必须通过 CI/CD 流程自动执行，严禁手动操作。

---

## 4. 前端与路由策略 (Frontend & SEO)

### 4.1 混合渲染模式 (Hybrid Rendering)
*   **SSG (静态生成)**:
    *   **适用**: 首页、29 个固定分类页、Top 500 热门模型详情页。
    *   **优势**: 极致的加载速度，对 AdSense 最友好。
*   **SSR (服务端渲染) / On-demand**:
    *   **适用**: 数千个长尾动态关键词页、冷门模型详情页、搜索结果页。
    *   **优势**: 节省构建时间，内容实时性强。

### 4.2 动态关键词页 (`/topic/[slug]`)
*   **内容填充 (AdSense Compliance)**:
    *   **核心要求**: 绝不生成“低价值”空白页。
    *   **AI 简介**: 每个话题页必须包含一段 200-300 字的、由 Llama-3 生成的高质量介绍，涵盖定义、应用场景及趋势。
    *   **结构**: 标题 (H1) -> AI 简介 -> Top 10 模型列表 -> 相关话题推荐。
*   **内链策略 (Internal Linking)**:
    *   **防孤岛**: 必须构建紧密的内链网络，防止动态页成为 SEO 孤岛。
    *   **实施**: 在每个模型详情页底部，随机展示 5-10 个“相关话题”链接；在分类页侧边栏展示“热门话题”。

### 4.3 广告与合规
*   **Layout 保持**: 严禁修改 `src/layouts/Layout.astro` 中的 AdSense 代码和 GTM 代码。
*   **广告位预留**: 在动态页面模板中预留 `<div id="ad-slot">`，避免 CLS (布局偏移)。

---

## 5. 搜索与社区功能 (Features)

### 5.1 实时搜索 API
*   **路径**: `/api/search`
*   **逻辑**: Cloudflare Worker 接收参数 -> 查询 D1 (`WHERE name LIKE %...%`) -> 返回 JSON。
*   **优化**: 对热门搜索词（如 "llama"）的结果进行 KV 缓存，缓存时间 1 小时。

### 5.2 社区互动 (Unified Community)
*   **原则**: **一个账号，畅行全站**。拒绝割裂的登录体验。
*   **评论系统**:
    *   **前端**: 自研评论组件，支持 Markdown 预览、回复、点赞。
    *   **后端**: `/api/comments` 处理增删改查。
    *   **权限**: 游客可见，登录用户可发/回/赞。
*   **评分/点赞**: 前端调用 `/api/interact` -> Worker 写入 D1 `user_interactions` 表。

### 5.3 用户系统 (User System - Auth.js)
*   **技术选型**: **Auth.js (v5)** + **@auth/d1-adapter**。
*   **认证源**: 仅启用 **GitHub** 和 **Google** Provider。
*   **数据流**:
    1.  用户点击 "Sign in with GitHub"。
    2.  Auth.js 处理 OAuth 回调。
    3.  自动在 D1 `users` 表创建/更新用户。
    4.  自动在 D1 `sessions` 表创建会话。
    5.  前端获取 Session，展示头像。
*   **功能**:
    *   **个人中心**: 读取 D1 `user_favorites` 表展示收藏。
    *   **模型收藏**: 关联 `users.id` 和 `models.id`。
    *   **模型提交**: 认证用户提交 URL -> 存入 `pending_models` -> 管理员(您)在 D1 后台审核 -> 脚本下一次运行时自动抓取入库。
    *   **评论互动**: 认证用户可发布评论，数据存入 `comments` 表。

### 5.4 内容安全与自动审核 (Content Safety)
*   **目标**: 零容忍色情、暴力、侵权及垃圾广告，确保 AdSense 账号安全。
*   **自动化方案**:
    1.  **关键词过滤**: 维护 `bad_words.json`，包含全球主要语言的违禁词。命中则直接拒绝提交。
    2.  **AI 智能审核**:
        *   利用 **Cloudflare Workers AI (Llama-3 或 Text Classification 模型)**。
        *   用户提交评论或模型描述时，触发 Worker 进行分析。
        *   **Prompt**: "Analyze this text for NSFW, violence, hate speech, or spam. Reply with SAFE or UNSAFE."
        *   如果 AI 返回 **UNSAFE**，则标记 `is_hidden=1`，并进入人工审核队列。
    3.  **举报机制**: 前端提供“举报”按钮，用户举报超过 3 次自动隐藏内容。
    4.  **人工兜底**: 在 D1 管理后台保留“申诉/复核”通道，每周人工抽检被 AI 拦截的内容，微调 Prompt 以减少误杀。

### 5.5 未来扩容路径 (Scalability Path)
*   **现状**: Cloudflare D1 (Free) 足以支撑日均 10万+ PV。
*   **未来 (日均 1000万+ PV)**:
    *   **数据库**: 平滑迁移至 **Cloudflare Hyperdrive** 连接外部高性能 PostgreSQL，或升级 D1 付费版。
    *   **代码**: 现有 SQL 逻辑完全兼容，无需重构，仅需更改连接配置。

### 5.6 自动化运营预备 (Serverless Automation)
*   **理念**: 替代 n8n 的“代码化自动化”方案。
*   **架构**: Cloudflare Workers + Cron Triggers。
*   **预留功能 (Future Ready)**:
    *   **社交媒体自动分发**: 监听 D1 新增模型 -> 调用 OpenAI 生成推文 -> 调用 Twitter/Discord API 发布。
    *   **邮件订阅**: 每周定时查询 D1 热门榜单 -> 生成 HTML 周报 -> 发送邮件。
    *   **现状**: 暂不实现，但架构已就绪，随时可编写 Worker 代码开启，无需购买 VPS 部署 n8n。

---

## 6. 备份与容灾策略 (Backup & Disaster Recovery)

为了确保数据绝对安全，我们实施“多地存储、自动快照”策略。

### 6.1 数据库备份 (D1 Database)
*   **自动化工具**: GitHub Actions (`.github/workflows/backup-db.yml`)。
*   **频率**: 每周一次 (Weekly)。
*   **流程**:
    1.  Action 触发，安装 `wrangler`。
    2.  执行 `wrangler d1 export ai-nexus-db --remote --output=./backup.sql`。
    3.  **存储 A (热备)**: 将 `backup.sql` 上传到 Cloudflare R2 的专用 Bucket (`ai-nexus-backups`)，保留最近 4 周的快照。
    4.  **存储 B (冷备)**: (可选) 将 SQL 文件加密后 Commit 到一个**私有** GitHub 仓库 (`ai-nexus-db-snapshots`)。

### 6.2 代码与配置备份 (Code & Config)
*   **策略**: Git 本身就是分布式备份系统。
*   **执行**: 所有代码、配置文件、SQL Schema 定义都托管在 GitHub 主仓库。
*   **安全**: 确保 GitHub 开启 2FA (双重认证)，防止账号被盗导致代码库被删。

### 6.3 灾难恢复流程 (Disaster Recovery)
如果 D1 数据库发生灾难性丢失或损坏：
1.  从 R2 或 私有仓库下载最新的 `backup.sql`。
2.  本地运行 `wrangler d1 execute ai-nexus-db --remote --file=./backup.sql`。
3.  数据即可完全恢复到上周的状态。

---

## 7. 分阶段实施路线图 (Execution Roadmap)

### 阶段一：基础设施准备 (Infrastructure)
- [ ] 在 Cloudflare 后台创建 D1 数据库 `ai-nexus-db`。
- [ ] 编写 SQL 脚本初始化表结构。
- [ ] 配置 Cloudflare R2 用于图片存储 (`ai-nexus-assets`) 和 数据库备份 (`ai-nexus-backups`)。
- [ ] 创建私有 GitHub 仓库用于冷备 (可选)。
- [ ] 编写 GitHub Action 自动备份脚本。

### 阶段二：数据引擎迁移 (Backend)
- [ ] 改造 `fetch-data.js`，引入 `cloudflare:d1` 绑定。
- [ ] 实现 `Upsert` 逻辑，停止生成本地 JSON 文件。
- [ ] 本地测试数据导入流程，确保 50,000+ 模型顺利入库。

### 阶段三：前端重构与动态化 (Frontend)
- [ ] 修改 `astro.config.mjs`，适配 Cloudflare Adapter (Hybrid 模式)。
- [ ] 创建 `/api/search` 端点，替换 Fuse.js。
- [ ] 开发动态路由页面 `src/pages/topic/[slug].astro`。
- [ ] 确保 `Layout.astro` 在所有新页面生效。

### 阶段四：社区与用户系统 (Community & User)
- [ ] 配置 Google Cloud Console 和 GitHub Developer Settings 获取 OAuth Client ID/Secret。
- [ ] 集成 **Auth.js**，配置 D1 Adapter。
- [ ] 创建 D1 用户相关表 (`users`, `accounts`, `sessions`, `user_favorites`, `comments`)。
- [ ] 开发“个人中心”页面。
- [ ] 开发自建评论组件 (`CommentSection.astro`) 及后端 API。
- [ ] 实现“坏链报告”功能。
- [ ] 部署 Cloudflare Workers AI 自动生成 FAQ (可选)。

### 阶段五：上线与验证 (Launch)
- [ ] 配置 `@astrojs/sitemap` 生成包含动态页面的 Sitemap。
- [ ] 部署到 Cloudflare Pages。
- [ ] 检查 AdSense 广告展示是否正常。
- [ ] 检查 GTM 数据流是否正常。
- [ ] 提交新 Sitemap 给 Google Search Console。

---

**备注**: 此文档作为项目 V3.0 的核心指导文件，所有代码变更应以此架构为准绳。
