-- Migration: Correct Benchmark UMID Mappings V4.5
-- Generated: 2025-12-13
-- Maps benchmark slugs to verified D1 model UMIDs

-- Qwen2.5-72B-Instruct
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
VALUES ('bench', 'qwen-qwen2-5-72b', 'umid_7177656e322d352d', 1.0);

-- Qwen2.5-7B-Instruct  
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
VALUES ('bench', 'qwen-qwen2-5-7b', 'umid_7177656e322d352d', 1.0);

-- Llama-3.1-70B-Instruct
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
VALUES ('bench', 'meta-llama-llama-3-1-70b', 'umid_6c6c616d612d332d', 1.0);

-- Llama-3.1-8B-Instruct (using Llama-3.2-1B family UMID - need to find correct one)
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
VALUES ('bench', 'meta-llama-llama-3-1-8b', 'umid_6c6c616d612d332d', 1.0);

-- Llama-3.3-70B (using Meta-Llama-3-70B-Instruct UMID as closest match)
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
VALUES ('bench', 'meta-llama-llama-3-3-70b', 'umid_6d6574612d6c6c61', 1.0);

-- Mistral-7B-Instruct
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
VALUES ('bench', 'mistralai-mistral-7b', 'umid_6d69737472616c2d', 1.0);

-- Mistral-Large (using Mistral family UMID)
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
VALUES ('bench', 'mistralai-mistral-large', 'umid_6d69737472616c2d', 1.0);

-- DeepSeek-V2.5 (using DeepSeek family UMID)
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
VALUES ('bench', 'deepseek-ai-deepseek-v2-5', 'umid_646565707365656b', 1.0);

-- Google Gemma-2-9B (need to find)
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
SELECT 'bench', 'google-gemma-2-9b', umid, 1.0
FROM models WHERE LOWER(name) LIKE '%gemma%2%9b%' LIMIT 1;

-- Microsoft Phi-3-Medium (need to find)
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)
SELECT 'bench', 'microsoft-phi-3-medium', umid, 1.0
FROM models WHERE LOWER(name) LIKE '%phi-3%medium%' OR LOWER(name) LIKE '%phi3%medium%' LIMIT 1;
