# 💻 Free2AITools Code Execution Standard (CES V5.1.2)

**文档 ID**: CES-V5.1.2-FINAL
**生效日期**: 2025-12-16
**状态**: 🟢 **FROZEN FOR EXECUTION (强制执行)**
**适用范围**: Frontend (Astro), Backend (Workers), Infrastructure (R2/D1/Queues)
**违规后果**: PR 自动关闭 (CI Blocked)，严重违规将视为技术债务回滚。

-----

## 1. 通用开发铁律 (General Iron Laws)

  * **语言统一 (Art 0.2)**: 所有代码变量命名、注释、日志输出必须使用 **English**。
  * **绝密保护 (Art 0.1)**: `docs/CONSTITUTION*`, `docs/*PLAN*`, `docs/*PROMPT*` 严禁提交至公共仓库，必须列入 `.gitignore`。
  * **模块化架构 (Anti-Monolith)**:
      * Worker 代码必须遵循 "Modular Step Architecture"（拆分为 `steps/`, `consumers/`, `utils/`）。
      * **行数熔断**: 单个 `.ts` / `.js` 文件代码行数 **MUST ≤ 250 行**。超过必须拆分。

-----

## 2. 后端开发标准 (L8 Worker / Unified Workflow)

### 2.1 数据实体化 (Materialization)

  * **Gzip 强制 (Art 2.4.2)**: 所有写入 R2 的 JSON 文件（除了极小的 meta 文件）必须压缩。
    ```typescript
    // ✅ CORRECT
    await env.R2.put(key, gzippedBuffer, {
      httpMetadata: { contentEncoding: 'gzip', contentType: 'application/json' }
    });
    ```
  * **分页生成 (Art 2.4)**: 生成排行榜 (`rankings/`) 时：
      * **Loop**: 每 1000 个实体切分为一个 `p{n}.json`。
      * **Cap**: 循环必须在 `p50.json` 处强制 `break`（只生成 Top 50,000）。
      * **Meta**: 必须生成配对的 `meta.json` (包含 `total`, `pages`, `updated_at`)。
  * **热索引生成**:
      * SQL 查询必须包含 `LIMIT 20000`。
      * 排序必须混合权重：`(FNI * 0.7 + Popularity * 0.3)`。

### 2.2 队列与流控 (Queue & Hydration)

  * **生产者 (Producer)**: 在 `cron` 触发任务前，必须检查全局暂停开关。
    ```typescript
    const isPaused = await env.KV.get('SYSTEM_PAUSE');
    if (isPaused === '1') return; // Kill-Switch Engaged
    ```
  * **消费者 (Consumer)**:
      * **Batch Size**: 根据 CPU 负载动态调整 (100-300)。
      * **Hash Check (Class A 优化)**: 写入 R2 前必须对比 Hash，内容未变则跳过写入。
    <!-- end list -->
    ```typescript
    // ✅ Hash Check Optimization
    const existing = await env.R2.head(key);
    if (existing && existing.customMetadata?.sha256 === newHash) {
        return; // Skip Write (Save $0.50/million)
    }
    ```

-----

## 3. 前端开发标准 (Astro / Pages)

### 3.1 零数据库原则 (Zero D1)

  * **绝对禁区**: `src/pages` 和 `src/components` 下严禁出现 `env.DB` 或 `import { D1Database }`。
  * **数据源**: 所有数据必须通过 `fetch('https://R2_URL/cache/...')` 获取。

### 3.2 客户端搜索 (Client Search)

  * **Web Worker (Art 2.2.2)**: `Fuse.js` 初始化和搜索必须在 `src/workers/search.worker.js` 中运行，严禁阻塞主线程。
  * **50ms 熔断 (Art 3.2)**: 搜索调用必须包裹在 `Promise.race` 中：
    ```javascript
    const result = await Promise.race([
      worker.search(query),
      new Promise((_, reject) => setTimeout(() => reject('TIMEOUT'), 50))
    ]);
    ```

### 3.3 无限滚动与分页 (Pagination UX)

  * **加载策略**: 首屏仅加载 `p1.json`。
  * **终止条件**: 当加载完第 5 页 (`p5.json`)，必须停止自动加载，显示 "View full list via Filters"。
  * **降级处理**: 如果检测到低端设备，禁用滚动监听，改为 "Load More" 按钮。
    ```javascript
    // ✅ Low-end Device Detection (Patched for iOS Compatibility)
    // deviceMemory is undefined on Safari, default to 8 to avoid false positives
    const memory = navigator.deviceMemory || 8; 
    const isLowEnd = navigator.hardwareConcurrency <= 4 || memory <= 4;
    ```

-----

## 4. 基础设施配置标准 (Infrastructure)

### 4.1 R2 目录结构 (Directory Layout)

必须严格遵循以下结构，禁止在根目录乱放文件：

```text
/cache/
 ├─ index/           # index_hot.json ONLY
 ├─ rankings/        # 分页 JSON (p1.json...)
 ├─ entities/        # 详情 JSON (model/dataset/paper)
 └─ meta/            # checkpoint.json, build_manifest.json
```

### 4.2 缓存规则 (Cache Rules)

  * Worker 代码中严禁处理静态文件的缓存逻辑，必须依赖 Cloudflare Dashboard 的 Cache Rules。
  * **Bypass**: `/cache/meta/*` 和 `/api/search` 必须设置为 **BYPASS**。
  * **TTL**: `/cache/entities/*` 必须设置为 **7 Days**。

-----

## 5. CI/CD 拦截标准 (The Gates)

任何提交如果触发以下脚本报错，视为**违宪代码**，构建必须失败：

1.  **D1 泄漏检测 (Zero D1)**:
    `grep -r "env.DB" src/pages/ && exit 1`
2.  **热索引大小检测 (Max 500KB)**:
    `ls -lh cache/index/index_hot.json.gz | awk '{if ($5 > 500000) exit 1}'`
3.  **排行榜分页大小检测 (Max 300KB)**:
    `find cache/rankings -name "p*.json.gz" -size +300k && exit 1`
4.  **排行榜分页数量检测 (Max 50 Pages)**:
    `ls cache/rankings/text-generation/p*.json.gz | wc -l | awk '{if ($1 > 50) exit 1}'`
5.  **Monolith 检测 (Max 250 Lines)**:
    `find src workers -name "*.ts" ... [check line count > 250]`

-----

**Ratified By:**

`Helios` (Chief Architect)
`Grok 4` (Advisory Architect)

**Date**: 2025-12-16
**System Status**: 🟢 **SELF-DEFENDING**
