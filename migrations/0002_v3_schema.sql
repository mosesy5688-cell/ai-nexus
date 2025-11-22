-- Migration number: 0002 	 2025-11-22T00:00:00.000Z
-- Description: V3.0 Helios-AutoPilot Schema

-- Drop existing tables to ensure clean state for V3.0
DROP TABLE IF EXISTS models;
DROP TABLE IF EXISTS models_fts;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS comments;
-- We keep other tables for now or drop them if they conflict. 
-- The V3.0 plan implies a strict schema.

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
    content_rowid='rowid'
);

-- C. 搜索索引自动同步触发器 (Triggers)
CREATE TRIGGER models_ai AFTER INSERT ON models BEGIN
  INSERT INTO models_fts(rowid, name, description, seo_summary, author, tags) 
  VALUES (new.rowid, new.name, new.description, new.seo_summary, new.author, new.tags);
END;
-- (注: Update 和 Delete 的触发器逻辑同上，确保索引实时一致)
CREATE TRIGGER models_au AFTER UPDATE ON models BEGIN
  INSERT INTO models_fts(models_fts, rowid, name, description, seo_summary, author, tags) 
  VALUES('delete', old.rowid, old.name, old.description, old.seo_summary, old.author, old.tags);
  INSERT INTO models_fts(rowid, name, description, seo_summary, author, tags) 
  VALUES (new.rowid, new.name, new.description, new.seo_summary, new.author, new.tags);
END;
CREATE TRIGGER models_ad AFTER DELETE ON models BEGIN
  INSERT INTO models_fts(models_fts, rowid, name, description, seo_summary, author, tags) 
  VALUES('delete', old.rowid, old.name, old.description, old.seo_summary, old.author, old.tags);
END;

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
