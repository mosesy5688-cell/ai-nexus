-- Migration number: 0001 	 2025-11-21T05:45:00.000Z
-- Description: Initial V3.0 Schema

-- 1. Models Table (Core Asset)
CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,          -- e.g., "meta-llama/Meta-Llama-3-8B"
    name TEXT NOT NULL,
    author TEXT NOT NULL,
    description TEXT,
    tags TEXT,                    -- JSON array of tags
    pipeline_tag TEXT,            -- e.g., "text-generation"
    likes INTEGER DEFAULT 0,
    downloads INTEGER DEFAULT 0,
    created_at DATETIME,          -- Source creation time
    last_updated DATETIME,        -- Local update time
    first_indexed DATETIME DEFAULT CURRENT_TIMESTAMP,
    link_status TEXT DEFAULT 'ok',-- 'ok', 'broken'
    source_url TEXT
);

-- 2. Keywords Table (Dynamic Pages)
CREATE TABLE IF NOT EXISTS keywords (
    slug TEXT PRIMARY KEY,        -- e.g., "text-to-video"
    title TEXT NOT NULL,
    parent_category TEXT,         -- 29 fixed categories
    description TEXT,             -- AI generated summary
    is_trending BOOLEAN DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 3. Users Table (Auth.js)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT UNIQUE,
    emailVerified DATETIME,
    image TEXT
);

-- 4. Accounts Table (Auth.js)
CREATE TABLE IF NOT EXISTS accounts (
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

-- 5. Sessions Table (Auth.js)
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    sessionToken TEXT UNIQUE NOT NULL,
    userId TEXT NOT NULL,
    expires DATETIME NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

-- 6. Verification Tokens Table (Auth.js)
CREATE TABLE IF NOT EXISTS verification_tokens (
    identifier TEXT NOT NULL,
    token TEXT NOT NULL,
    expires DATETIME NOT NULL,
    PRIMARY KEY (identifier, token)
);

-- 7. User Favorites Table
CREATE TABLE IF NOT EXISTS user_favorites (
    user_id TEXT,
    model_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, model_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 8. Comments Table (Custom System)
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    parent_id INTEGER,            -- For nested replies
    likes INTEGER DEFAULT 0,
    is_hidden BOOLEAN DEFAULT 0,  -- Moderation flag
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 9. Pending Models Table (User Submission)
CREATE TABLE IF NOT EXISTS pending_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    url TEXT NOT NULL,
    status TEXT DEFAULT 'pending',-- 'pending', 'approved', 'rejected'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 10. User Interactions Table (Analytics)
CREATE TABLE IF NOT EXISTS user_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT,
    action_type TEXT,             -- 'like', 'star', 'report_broken'
    ip_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 11. System Settings Table (Config)
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,         -- e.g., 'ad_enabled'
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_models_likes ON models(likes DESC);
CREATE INDEX IF NOT EXISTS idx_models_tags ON models(tags);
CREATE INDEX IF NOT EXISTS idx_comments_model ON comments(model_id);
