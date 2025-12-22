---
layout: ../../layouts/KnowledgeLayout.astro
title: RAG (Retrieval Augmented Generation)
slug: rag
---

# RAG - Retrieval Augmented Generation

RAG combines LLMs with external knowledge retrieval for accurate, up-to-date responses.

## How RAG Works

1. **Query** → User asks a question
2. **Retrieve** → Search vector database for relevant documents
3. **Augment** → Add documents to LLM prompt
4. **Generate** → LLM produces grounded response

## RAG vs Fine-Tuning

| Aspect | RAG | Fine-Tuning |
|--------|-----|-------------|
| Knowledge updates | Instant | Requires retraining |
| Cost | Lower | Higher |
| Accuracy | Very high | High |
| Setup complexity | Medium | High |

## RAG Stack Components

| Component | Options |
|-----------|---------|
| Embeddings | OpenAI, BGE, E5 |
| Vector DB | Pinecone, Chroma, Weaviate |
| LLM | GPT-4, Claude, Llama |
| Framework | LangChain, LlamaIndex |

## Best Practices

1. **Chunk wisely** - 512-1024 tokens per chunk
2. **Use hybrid search** - Combine semantic + keyword
3. **Add metadata** - Source, date, relevance
4. **Evaluate** - Test retrieval accuracy

## Related

- [Embeddings](/knowledge/embeddings)
- [Context Length](/knowledge/context-length)
