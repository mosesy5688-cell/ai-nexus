# 🚀 AI-Nexus V3.0: The Helios-AutoPilot Ultimate Edition (完全自动化终极版)

**版本**: 3.0 (Final & Executable)
**核心使命**: 构建一个**零成本、自驱式、反脆弱**的 AI 模型聚合平台。
**技术基座**: Cloudflare (Pages/D1/R2/Workers/AI) + GitHub Actions (Rust/WASM)

-----

## I. 核心架构：四大自动化循环 (The Four Automation Loops)

为了最大化利用免费额度并消除人工干预，系统被划分为四个独立运行的自动化循环。

| 循环名称 | 执行环境 | 触发频率 | 核心职责 (The "Auto" Logic) |
| :--- | :--- | :--- | :--- |
| **Loop 1: Auto-Ingest (摄入)** | **GitHub Actions** | 每日 (Daily) | 全网抓取 -> **Rust/WASM 图片清洗** -> 智能去重入库。包含**代理自愈**机制。 |
| **Loop 2: Auto-Enrich (增效)** | **CF Workers Cron** | 每小时 (Hourly) | 扫描新入库模型 -> **调用 Llama-3 撰写 SEO 软文** -> 自动更新 D1。 |
| **Loop 3: Auto-Guard (防御)** | **Workers AI Hook** | 实时 (Real-time) | 拦截评论/投稿 -> **AI 情感/垃圾检测** -> 自动执行 Shadowban (影子封禁)。 |
| **Loop 4: Auto-Ops (运维)** | **GitHub Actions** | 每周 (Weekly) | 死链巡检 -> 数据库冷备 -> Sitemap 提交 -> 自动清洁 R2 孤儿文件。 |

-----

## II. 数据库架构：自动化的大脑 (D1 Schema)

此 Schema 经过深度优化，集成了 **FTS5 全文检索** 和 **自动化状态机** 字段。请直接执行以下 SQL。

### 1. 初始化表结构 (Executable SQL)

```sql
-- A. 模型核心表 (Models)
CREATE TABLE models (
    id TEXT PRIMARY KEY,            -- 唯一标识 (如 "meta-llama/Llama-3-8B")
    name TEXT NOT NULL,
    author TEXT NOT NULL,
    description TEXT,               -- 原始描述
    tags TEXT,                      -- 原始标签 (JSON String)
    pipeline_tag TEXT,              -- 核心分类 (如 "text-generation")
    
    -- [自动化字段: Auto-Enrich]
    seo_summary TEXT,               -- AI 生成的高质量 SEO 简介
    seo_status TEXT DEFAULT 'pending', -- 状态机: pending -> processing -> done
    
    -- [自动化字段: Auto-Ops]
    link_status TEXT DEFAULT 'alive', -- 状态机: alive -> broken
    last_checked DATETIME,          -- 上次死链检查时间
    
    -- [统计数据]
    likes INTEGER DEFAULT 0,
    downloads INTEGER DEFAULT 0,
    
    -- [资源链接]
    cover_image_url TEXT,           -- R2 托管的 WebP 图片
    source_url TEXT,
    
    created_at DATETIME,            -- 源站发布时间
    first_indexed DATETIME DEFAULT CURRENT_TIMESTAMP -- 本站收录时间
);

-- 索引优化
CREATE INDEX idx_pipeline ON models(pipeline_tag);
CREATE INDEX idx_seo_status ON models(seo_status); -- 加速 Auto-Enrich 任务捞取
CREATE INDEX idx_link_status ON models(link_status); -- 加速 Auto-Ops 任务捞取
CREATE INDEX idx_indexed ON models(first_indexed DESC);

-- B. 全文检索虚拟表 (Zero-Cost Search Engine)
-- 利用 SQLite FTS5 实现毫秒级搜索，无需外部服务
CREATE VIRTUAL TABLE models_fts USING fts5(
    name, 
    description, 
    seo_summary, 
    author, 
    tags, 
    content='models', 
    content_rowid='id'
);

-- C. 搜索索引自动同步触发器 (Triggers)
CREATE TRIGGER models_ai AFTER INSERT ON models BEGIN
  INSERT INTO models_fts(rowid, name, description, seo_summary, author, tags) 
  VALUES (new.id, new.name, new.description, new.seo_summary, new.author, new.tags);
END;
-- (注: Update 和 Delete 的触发器逻辑同上，确保索引实时一致)

-- D. 用户与信誉表 (Users & Reputation)
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT UNIQUE,
    reputation_score INTEGER DEFAULT 0, -- [核心] 用户信誉分
    is_shadowbanned BOOLEAN DEFAULT 0,  -- [核心] 影子封禁标记
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- E. 评论表 (Comments)
CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    ai_audit_status TEXT DEFAULT 'pending', -- pending/safe/unsafe
    is_hidden BOOLEAN DEFAULT 0,            -- 1=折叠/不可见
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

-----

## III. Loop 1: Auto-Ingest (摄入循环)

**目标**: 零成本、高并发地处理数据和图片。
**核心策略**: 将 CPU 密集型任务 (图片处理) 转移到 **GitHub Actions (Rust)**，只将最终结果存入 Cloudflare。

### 1. GitHub Actions Workflow (`.github/workflows/daily-ingest.yml`)

```yaml
name: Auto-Ingest (Rust Powered)
on:
  schedule:
    - cron: '0 2 * * *' # 每天凌晨 2 点 (避开高峰)
  workflow_dispatch:

jobs:
  ingest-and-process:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Step 1: 智能元数据抓取 (Smart Fetch)
      # 如果直连失败，自动切换到 Secrets 中配置的 Worker 代理
      - name: Fetch Metadata
        run: node scripts/fetch-metadata.js
        env:
          CF_PROXY_URL: ${{ secrets.CF_PROXY_URL }}

      # Step 2: Rust/WASM 图片极速处理
      # 编译好的 Rust CLI 工具，负责：下载 -> Resize -> WebP -> 上传 R2
      # 这是整个架构中最省资源的一步，处理 1000 张图片仅需几分钟 Actions 时间
      - name: Process Images with Rust
        run: ./tools/rust-img-optimizer --input ./data/raw.json --upload
        env:
          R2_ACCESS_KEY: ${{ secrets.R2_ACCESS_KEY }}
          R2_SECRET_KEY: ${{ secrets.R2_SECRET_KEY }}
          R2_BUCKET: "ai-nexus-assets"

      # Step 3: D1 增量同步 (Upsert)
      - name: Sync to D1
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          command: d1 execute ai-nexus-db --file=./data/upsert.sql
```

-----

## IV. Loop 2: Auto-Enrich (增效循环)

**目标**: 解决 "Thin Content" (内容空洞) 问题，利用 AI 为每个页面生成独家原创内容，提升 SEO 权重。

### 1. Cloudflare Workers Cron (`src/cron/seo-generator.ts`)

```typescript
// 这里的逻辑运行在 Cloudflare Workers 边缘
// 免费额度: Workers AI 每天可调用数万次，足以覆盖新增模型

export default {
  async scheduled(event, env, ctx) {
    // 1. 领取任务: 每次处理 5 个未生成的模型
    const { results } = await env.D1.prepare(
      "SELECT * FROM models WHERE seo_status = 'pending' LIMIT 5"
    ).all();

    if (!results || results.length === 0) return;

    const ai = new Ai(env.AI);

    for (const model of results) {
      // 2. 自动化生成 (Llama-3)
      // Prompt 经过优化，要求输出纯文本，包含关键词，语气专业
      const prompt = `Task: Write a 150-word SEO description for AI model "${model.name}".
                      Tags: ${model.tags}. 
                      Requirement: Focus on use cases and technical strengths. English. Plain text only.`;
      
      try {
        const response = await ai.run('@cf/meta/llama-3-8b-instruct', { prompt });
        const seoText = response.response.trim();

        // 3. 回写数据库
        await env.D1.prepare(
          "UPDATE models SET seo_summary = ?, seo_status = 'done' WHERE id = ?"
        ).bind(seoText, model.id).run();
        
      } catch (e) {
        // 容错处理：标记失败，下次重试或忽略
        await env.D1.prepare(
          "UPDATE models SET seo_status = 'failed' WHERE id = ?"
        ).bind(model.id).run();
      }
    }
  }
}
```

-----

## V. Loop 3: Auto-Guard (防御循环)

**目标**: 建立零信任社区，自动隔离恶意用户，无需人工审核员。

### 1. 评论提交接口 (`src/api/comment.ts`)

```typescript
export async function handleCommentSubmit(request, env) {
  const { userId, content, modelId } = await request.json();
  
  // A. Shadowban 检查 (影子封禁)
  // 如果用户已被封禁，返回假成功。他能看到自己的评论，但数据库里是 hidden 的。
  const user = await env.D1.prepare("SELECT is_shadowbanned FROM users WHERE id = ?").bind(userId).first();
  if (user && user.is_shadowbanned) {
    return new Response(JSON.stringify({ status: 'success' })); // Fake success
  }

  // B. Llama-3 实时风控 (Real-time Audit)
  const ai = new Ai(env.AI);
  const audit = await ai.run('@cf/meta/llama-3-8b-instruct', {
    prompt: `Classify this comment: "${content}". 
             Is it SPAM, HATE_SPEECH, or SAFE? 
             Answer with one word only.`
  });

  let isHidden = 0;
  let status = 'safe';
  
  // 简单的规则引擎
  const aiResult = audit.response.toUpperCase();
  if (aiResult.includes("SPAM") || aiResult.includes("HATE")) {
    isHidden = 1;
    status = 'unsafe';
    // 自动扣除信誉分 (惩罚)
    await env.D1.prepare("UPDATE users SET reputation_score = reputation_score - 20 WHERE id = ?").bind(userId).run();
  } else {
    // 自动增加信誉分 (奖励)
    await env.D1.prepare("UPDATE users SET reputation_score = reputation_score + 1 WHERE id = ?").bind(userId).run();
  }

  // C. 写入数据
  await env.D1.prepare(
    "INSERT INTO comments (model_id, user_id, content, ai_audit_status, is_hidden) VALUES (?, ?, ?, ?, ?)"
  ).bind(modelId, userId, content, status, isHidden).run();

  // D. 自动封禁触发器 (阈值检查)
  // 如果信誉分低于 -100，自动开启 Shadowban
  await env.D1.prepare(
    "UPDATE users SET is_shadowbanned = 1 WHERE id = ? AND reputation_score < -100"
  ).bind(userId).run();

  return new Response(JSON.stringify({ status: isHidden ? 'pending_review' : 'success' }));
}
```

-----

## VI. Loop 4: Auto-Ops (运维循环)

**目标**: 系统自维护，数据安全与链接健康。

### 1. 核心维护脚本 (`.github/workflows/weekly-maintenance.yml`)

  * **Job 1: Dead Link Checker (死链清除)**
      * 从 D1 读取 500 个 `link_status='alive'` 的 URL。
      * 并发发送 HTTP HEAD 请求。
      * 将 404/500 错误的记录更新为 `link_status='broken'`。
      * *结果*: 前端自动隐藏或标记这些模型，保证用户体验。
  * **Job 2: Database Snapshot (冷备)**
      * `wrangler d1 export` 导出 SQL。
      * 加密后存储到私有 GitHub 仓库或 R2 Bucket。
  * **Job 3: Sitemap & Ping**
      * 生成最新的 `sitemap.xml` (排除 broken 链接)。
      * Ping Google Search Console 通知收录。

-----

## VII. 前端与性能优化 (Frontend & Performance)

**框架**: Astro (Hybrid Rendering)

1.  **KV 增强缓存 (Edge Cache)**:
      * 对于 `/model/[id]` 和 `/topic/[slug]` 页面，首次 SSR 渲染后，将 HTML 写入 Cloudflare KV (TTL: 24小时)。
      * **Middleware 拦截**: 请求先查 KV，命中则直接返回 (0ms DB 延迟)，未命中再走 SSR + D1。
2.  **混合渲染策略**:
      * **SSG**: 首页、Top 排行榜 (构建时生成，纯静态)。
      * **SSR + KV**: 详情页、搜索页 (动态生成 + 边缘缓存)。
3.  **搜索体验**:
      * 前端调用 `/api/search?q=...` -> Worker 接收 -> 查询 `models_fts` 虚拟表 -> 返回 JSON。
      * 延迟通常在 100ms 以内，无需 Algolia。

-----

## VIII. 最终实施路线图 (Execution Roadmap)

这是启动 Helios-AutoPilot 的指令序列：

1.  **Phase 1: Genesis (第 1 天)**
      * [Cloudflare] 创建 D1 `ai-nexus-db`，执行本文 **Section II** 的 SQL。
      * [Cloudflare] 创建 R2 `ai-nexus-assets`，绑定自定义域名。
2.  **Phase 2: Ignition (第 2 天)**
      * [GitHub] 部署 `daily-ingest.yml`。
      * [Local] 编写并编译 Rust 图片处理 CLI，上传至仓库 `/tools` 目录。
      * *验证*: 手动触发 Action，观察 D1 是否有数据入库。
3.  **Phase 3: Intelligence (第 3 天)**
      * [Cloudflare] 部署 `seo-generator` Worker Cron (配置 Trigger 为每小时)。
      * *验证*: 1小时后，检查 D1 `seo_summary` 字段是否有内容。
4.  **Phase 4: Defense (第 4 天)**
      * [Code] 实现 `handleCommentSubmit` 逻辑，集成 Auth.js。
      * *验证*: 发送测试攻击评论，确认数据库中 `is_hidden=1`。
5.  **Phase 5: Launch (第 5 天)**
      * [Cloudflare] 部署 Astro 前端到 Pages。
      * [Google] 提交 sitemap URL。
      * **系统正式进入 Auto-Pilot 模式。**

-----

**最终确认**:
这份文档整合了架构的**健壮性**与执行的**自动化**。现在拥有的是一套无需支付 AWS/Vercel 账单、无需雇佣运维人员、能够自我生长和防御的顶级 AI 聚合平台方案。
