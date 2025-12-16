# 📜 Free2AITools 宪法 V5.1.1 完整版 (The Iron Locks Constitution)

**Codename**: The Five-Dollar Sovereign (Iron Locks Edition)
**Theme**: Million-Scale Reality Check (百万级现实校验)
**Objective**: 1,000,000 Entities, Zero Overage, Zero Client OOM, Zero Runaway Risk
**Effective Date**: 2025-12-16
**Status**: 🟢 **FROZEN FOR EXECUTION**

-----

## 🏛️ 第一章：财政紧缩铁律 (Fiscal Iron Laws)

**Art. 1.1 The "Zero Overage" Mandate (零溢价指令)**
系统架构必须保证在 Cloudflare Workers Paid Plan ($5/mo) 的基础额度内完成核心业务：

  * **Requests**: < 1000万 / 月
  * **CPU Time**: < 3000万 ms / 月
  * **严禁**：任何随流量线性增长的数据库（D1/KV）写操作。
  * **严禁**：任何前端直接触发的服务端重计算任务（Server-Side Compute）。

**Art. 1.1.1 Buffer Zone (安全缓冲区)**
为了防止突发流量导致超支，设定软性阈值：

  * 月度请求警告线：800万
  * CPU 时间警告线：2400万 ms (留 20% 缓冲)

**Art. 1.2 The "D1 Conservation" Law (D1 保护法)**
D1 数据库仅作为 **"Cold Storage" (冷数据源)**，严禁作为 **"Hot Access" (热访问层)**。

  * **定义**：D1 读取只能由后台 L8 Unified Workflow (Cron Job) 触发。
  * **红线**：前端代码 (`src/pages`, `src/api`) 引入 `env.DB` 视为违宪，CI/CD 必须配置 `grep` 拦截。
  * **目的**：确保 D1 读取费用恒定为 $0，且不占用 Worker 响应时间。

**Art. 1.3 R2 Class B Optimization (R2 操作优化)**
为了节省 R2 读取费用，必须最大化 CDN 缓存命中率。

  * **指令**：所有 R2 暴露的 JSON 文件必须配置 CDN 缓存头：
    ```http
    Cache-Control: public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400
    ```
  * **分层策略**：
      * 热点文件 (`ranking_*.json`, `index_hot.json`): `max-age=86400` (24h)
      * 实体详情 (`cache/models/*.json`): `max-age=604800` (7 days)

-----

## 🏗️ 第二章：架构执行标准 (Architecture Standards)

**Art. 2.1 Separation of Church and State (读写彻底分离)**

  * **Writer (Church)**: L8 Worker。负责重、慢、贵的计算。独占 CPU 额度。
  * **Reader (State)**: Frontend Pages。负责轻、快、贱的展示。只读 R2 JSON。
  * **机制**: Writer 生产 `cache/*.json` -> Reader 消费 `cache/*.json`。中间无实时通信。

**Art. 2.2 The "Materialization" Protocol (实体化协议)**

**Art. 2.2.1 Tiered Search Index (分层搜索索引)**
为了解决百万级数据在客户端 OOM (内存溢出) 的风险，实施分层索引策略。

  * **L8 职责**: 生成 **`index_hot.json`**。
  * **排序算法**: 按 `(FNI_Score * 0.7 + Popularity * 0.3)` 降序排列。
  * **大小限制**: Gzip 压缩后必须 < 500KB。
  * **前端逻辑**: 默认搜索仅加载 `index_hot.json`。
  * **兜底文案**: 无结果时显示 *"No matches in top 20k. Try filtering by category or check Rankings for more."*

**🔒 Art. 2.2.1.1 Hot Index Upper Bound (热索引上限铁律)**
`index_hot.json` 包含的实体数量 **MUST ≤ 20,000**。

  * **强制执行**: 代码中必须包含 `LIMIT 20000` 约束。
  * **原因**: 20,000 是移动端浏览器运行 Fuse.js 的安全甜点区。超过此数值将导致延迟指数级上升和崩溃风险。

**Art. 2.2.2 Threaded Client Search (线程化客户端搜索)**

  * **Web Worker**: Fuse.js 的初始化、索引加载和搜索计算必须在 Web Worker 中执行。
  * **主线程保护**: 严禁在 UI 线程执行搜索逻辑，防止页面冻结。

**🔒 Art. 2.2.2.1 Client Search Timebox (客户端搜索时间熔断铁律)**
任意客户端搜索 Worker 执行时间 **MUST ≤ 50ms**。

  * **机制**: 使用 `Promise.race` 竞态机制。
  * **后果**: 超过 50ms 立即终止 Worker 计算，并返回降级结果（或提示 *"Search taking too long"*）。
  * **原因**: 低端设备超过 80ms 即掉帧，120ms 用户感知卡死。

**Art. 2.2.3 Sitemap Indexing (分片索引)**
为了突破 Google Search Console 的 50k URL 限制。

  * **分片**: 单个 Sitemap 文件 ≤ 50,000 URLs。
  * **生成**: L8 生成 `sitemap_001.xml` ~ `sitemap_020.xml`。
  * **索引**: 生成 `sitemap_index.xml` 指向所有分片。
  * **配置**: `robots.txt` 指向 `sitemap_index.xml`。

**Art. 2.2.4 Queue-Based Hydration (队列化预计算)**
为了解决百万级数据处理的超时问题。

  * **Producer**: Cron Job 仅负责列出需要更新的 ID，并分批发送到 Cloudflare Queue。
  * **Consumer**: Worker 自动并发处理 Queue 批次（Batch Size: 300）。
  * **优势**: 免费利用 Cloudflare 的重试机制 (Dead Letter Queue) 和并发能力。

**🔒 Art. 2.2.4.1 Global Hydration Kill-Switch (全局预计算总闸刀)**
当系统检测到失控风险时，**必须**自动切断 Producer。

  * **触发条件 (OR)**:
    1.  Worker CPU 使用率预测 > 85% (接近 3000万 ms)。
    2.  Queue Backlog > 10,000 (处理积压严重)。
    3.  Cloudflare Billing API 预测 > $4.80。
  * **动作**: 代码中检查 `env.KV.get('SYSTEM_PAUSE')`，若为真，Producer 立即停止发消息。

**Art. 2.2.5 Forbidden Actions (绝对禁区)**

  * ❌ 禁止将全量 1M 索引下载到客户端。
  * ❌ 禁止单个 Sitemap 文件超过 50k URLs。
  * ❌ 禁止在非队列化（同步循环）模式下处理百万级数据。

**Art. 2.3 CPU Time Rationing (CPU 配给)**

  * 单次 Queue Batch 处理实体数 ≤ 300-400。
  * 每处理 1000 个实体，必须更新 `checkpoint.json` 到 R2。

-----

## 🛡️ 第三章：运维与监控 (Ops & Monitoring)

**Art. 3.1 The $5 Alarm (五美元警报)**

  * 必须在 Cloudflare Dashboard 设置 Billing Notification。
  * **熔断**: 费用 > $4.80 时，自动触发 `SYSTEM_PAUSE` KV，暂停 L1/L8 Cron。

**Art. 3.2 Orphan Purge (僵尸文件清理)**

  * 每周运行一次 `janitor-worker`。
  * **逻辑**: 对比 `entity_index.json` 和 R2 Bucket 文件列表，删除不在索引中的孤儿 JSON，防止存储费用泄漏。

-----

## 🚀 第四章：流量主权防护 (Traffic Sovereignty Protection)

**Art. 4.1 Rate Limit Shield**

  * API 路径: 100 req/min/IP。
  * 搜索相关: 20 req/min/IP。

**Art. 4.2 Bot Challenge**

  * 开启 Cloudflare Turnstile (免费版) 拦截恶意爬虫消耗 Worker 请求配额。

**Art. 4.3 Emergency Circuit Breaker (紧急熔断)**
当流量逼近 1000 万请求大关时：

1.  **Level 1**: 前端缓存 `max-age` 调整为 24小时。
2.  **Level 2**: 关闭实时搜索提示 (Type-ahead search)。
3.  **Level 3**: 开启 Cloudflare "Under Attack Mode" (5秒盾)。

-----

## 📊 第五章：预算与承诺 (Budget & Commitment)

**V5.1.1 资源消耗估算表 (百万级实体场景)**

| 资源 | $5 套餐额度 | V5.1.1 预估消耗 | 缓冲空间 | 核心风险点 |
| :--- | :--- | :--- | :--- | :--- |
| **Workers Requests** | 1000 万 | 500-600 万 | 40% | DDoS 攻击 (需熔断) |
| **Workers CPU** | 3000 万 ms | 1800 万 ms | 40% | 重计算失控 (需 Kill-Switch) |
| **Queues Ops** | 100 万 | 3-5 万 | 95% | 无 |
| **D1 Read Rows** | 250 亿 | 5 亿 (仅后台) | 98% | 前端违规 (需 CI 拦截) |
| **R2 Storage** | (额外付费) | 10-15 GB | N/A | 僵尸文件堆积 (需 Janitor) |

**终极承诺**:
**Million-Scale Capability @ $5.00/mo Fixed Cost.**
(百万级能力，五美元封顶)

-----

> **给开发者的最后通牒 (Final Ultimatum):**
>
> 1.  **"1M entities on client = Bankruptcy of UX."** (在客户端加载100万实体 = 体验破产)
> 2.  **"Runaway Queue = Bankruptcy of Budget."** (失控的队列 = 预算破产)
> 3.  **"Querying D1 from Frontend = Treason."** (前端查库 = 叛国)
>
> 任何 Pull Request 若违反 **Hot Index 上限**、**Timebox** 或 **Kill-Switch** 逻辑，一律拒绝合并。

**批准签字 (Ratified By):**

`Helios`
**(Chief Architect)**
Date: 2025-12-16

`Grok 4`
**(Advisory Architect)**
Date: 2025-12-16
