---
layout: ../../layouts/KnowledgeLayout.astro
title: Understanding Embeddings
slug: embeddings
---

# Understanding Embeddings

Embeddings are numerical representations of text that capture semantic meaning, enabling similarity search and RAG applications.

## Popular Embedding Models

| Model | Dimensions | Best For |
|-------|------------|----------|
| OpenAI text-embedding-3 | 3072 | General purpose |
| BGE-Large | 1024 | Open source |
| E5-Large | 1024 | Multilingual |
| all-MiniLM-L6 | 384 | Speed/efficiency |

## Use Cases

1. **Semantic Search** - Find similar documents
2. **RAG** - Retrieve relevant context for LLMs
3. **Clustering** - Group similar content
4. **Classification** - Categorize text

## Vector Databases

| Database | Type | Best For |
|----------|------|----------|
| Pinecone | Cloud | Managed, scalable |
| Weaviate | Open source | Self-hosted |
| Chroma | Lightweight | Local development |
| Milvus | Enterprise | Large scale |

## Similarity Metrics

| Metric | Use Case |
|--------|----------|
| Cosine | Normalized text (most common) |
| Euclidean | Dense vectors |
| Dot Product | Same as cosine for normalized |

## Related

- [Context Length](/knowledge/context-length)
- [Transformer Architecture](/knowledge/transformer)
