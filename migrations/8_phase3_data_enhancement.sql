-- Migration: Phase 3 Data Enhancement V4.3.2 (Corrected)
-- Deploy Score + Ollama Status + Backfill Progress Table
-- Constitution V4.3.2 Compliant

-- 3.2 Deploy Score Calculation on model_specs table
-- deploy_score = GGUF(0.4) + context(0.1-0.2) + size(0.1-0.2)
UPDATE model_specs SET
    deploy_score = (
        CASE WHEN quantization_formats LIKE '%gguf%' THEN 0.4 ELSE 0 END
    ) + (
        CASE WHEN context_length > 8192 THEN 0.2 ELSE 0.1 END
    ) + (
        CASE WHEN params_billions IS NOT NULL AND params_billions < 10 THEN 0.2 ELSE 0.1 END
    )
WHERE deploy_score IS NULL OR deploy_score = 0;

-- Sync deploy_score to models table (join on umid)
UPDATE models SET
    deploy_score = (
        SELECT ms.deploy_score FROM model_specs ms 
        WHERE ms.umid = models.umid
    )
WHERE umid IN (SELECT umid FROM model_specs WHERE deploy_score > 0);

-- 3.3 Ollama Status Fix - Mark popular models as Ollama-available
UPDATE models SET has_ollama = 1, ollama_id = 'mistral:7b'
WHERE LOWER(name) LIKE '%mistral%7b%' AND (has_ollama IS NULL OR has_ollama = 0);

UPDATE models SET has_ollama = 1, ollama_id = 'gemma:7b'
WHERE LOWER(name) LIKE '%gemma%7b%' AND (has_ollama IS NULL OR has_ollama = 0);

UPDATE models SET has_ollama = 1, ollama_id = 'llama3:8b'
WHERE LOWER(name) LIKE '%llama%3%8b%' AND (has_ollama IS NULL OR has_ollama = 0);

UPDATE models SET has_ollama = 1, ollama_id = 'qwen2:7b'
WHERE LOWER(name) LIKE '%qwen%2%7b%' AND (has_ollama IS NULL OR has_ollama = 0);

UPDATE models SET has_ollama = 1, ollama_id = 'phi3:medium'
WHERE LOWER(name) LIKE '%phi%3%' AND LOWER(name) LIKE '%medium%' AND (has_ollama IS NULL OR has_ollama = 0);

UPDATE models SET has_ollama = 1, ollama_id = 'deepseek-coder:6.7b'
WHERE LOWER(name) LIKE '%deepseek%coder%' AND (has_ollama IS NULL OR has_ollama = 0);

-- 3.4 Backfill Progress Table (for tracking incremental AI summary generation)
CREATE TABLE IF NOT EXISTS backfill_progress (
    date TEXT PRIMARY KEY,
    models_processed INTEGER DEFAULT 0,
    quota_used INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Insert today's baseline
INSERT OR IGNORE INTO backfill_progress (date, models_processed, quota_used, errors)
VALUES (DATE('now'), 0, 0, 0);
