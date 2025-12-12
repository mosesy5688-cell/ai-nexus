-- Migration: Add benchmark slug mappings to umid_resolver
-- This maps benchmark UMIDs (like qwen-qwen2-5-72b) to actual D1 model UMIDs

-- First, try to find and map benchmark slugs to existing models by matching name patterns
-- These are approximate mappings based on model names

-- Qwen models
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
SELECT 'bench', 'qwen-qwen2-5-72b', umid, 1.0
FROM models 
WHERE LOWER(name) LIKE '%qwen2.5%72b%' OR LOWER(canonical_name) LIKE '%qwen2-5%72b%'
LIMIT 1;

INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
SELECT 'bench', 'qwen-qwen2-5-7b', umid, 1.0
FROM models 
WHERE LOWER(name) LIKE '%qwen2.5%7b%' AND LOWER(name) NOT LIKE '%72b%'
LIMIT 1;

-- Meta Llama models
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
SELECT 'bench', 'meta-llama-llama-3-3-70b', umid, 1.0
FROM models 
WHERE LOWER(name) LIKE '%llama%3.3%70b%' OR LOWER(id) LIKE '%llama-3.3-70b%'
LIMIT 1;

INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
SELECT 'bench', 'meta-llama-llama-3-1-70b', umid, 1.0
FROM models 
WHERE LOWER(name) LIKE '%llama%3.1%70b%' OR LOWER(id) LIKE '%llama-3.1-70b%'
LIMIT 1;

INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
SELECT 'bench', 'meta-llama-llama-3-1-8b', umid, 1.0
FROM models 
WHERE LOWER(name) LIKE '%llama%3.1%8b%' OR LOWER(id) LIKE '%llama-3.1-8b%'
LIMIT 1;

-- Mistral
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
SELECT 'bench', 'mistralai-mistral-large', umid, 1.0
FROM models 
WHERE LOWER(name) LIKE '%mistral%large%' OR LOWER(id) LIKE '%mistral-large%'
LIMIT 1;

-- DeepSeek
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
SELECT 'bench', 'deepseek-ai-deepseek-v2-5', umid, 1.0
FROM models 
WHERE LOWER(name) LIKE '%deepseek%v2.5%' OR LOWER(id) LIKE '%deepseek-v2%'
LIMIT 1;

-- Cohere Command
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
SELECT 'bench', 'cohereforai-c4ai-command', umid, 1.0
FROM models 
WHERE LOWER(name) LIKE '%c4ai%command%' OR LOWER(id) LIKE '%command-r%'
LIMIT 1;

-- Yi
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
SELECT 'bench', '01-ai-yi-1-5-34b', umid, 1.0
FROM models 
WHERE LOWER(name) LIKE '%yi%1.5%34b%' OR LOWER(id) LIKE '%yi-1.5-34b%'
LIMIT 1;

-- InternLM
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
SELECT 'bench', 'internlm-internlm2-5-20b', umid, 1.0
FROM models 
WHERE LOWER(name) LIKE '%internlm2%20b%' OR LOWER(id) LIKE '%internlm2%20b%'
LIMIT 1;
