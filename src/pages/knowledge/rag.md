---
layout: ../../layouts/KnowledgeLayout.astro
title: What is Retrieval Augmented Generation?
slug: rag
description: Enhancing LLM responses by retrieving relevant context from external knowledge sources
keywords: rag, retrieval augmented generation, vector database, embeddings, knowledge base
---

# What is Retrieval Augmented Generation?

**RAG (Retrieval Augmented Generation)** is a technique that enhances language model responses by first retrieving relevant information from external knowledge sources, then using that context to generate more accurate and up-to-date answers.

## Why RAG?

| Problem | How RAG Helps |
|---------|---------------|
| Knowledge cutoff | Retrieves current information |
| Hallucinations | Grounds responses in real data |
| Domain expertise | Access specialized knowledge |
| Source attribution | Can cite retrieved documents |

## RAG Architecture

```
User Query
    ↓
[Embedding Model] → Query Vector
    ↓
[Vector Database] ← Search → Top-K Documents
    ↓
[LLM] ← Context + Query → Response
```

## Core Components

### 1. Document Processing
- Split documents into chunks
- Generate embeddings for each chunk
- Store in vector database

### 2. Retrieval
- Convert query to embedding
- Find similar chunks via vector search
- Return top-K relevant documents

### 3. Generation
- Combine retrieved context with user query
- Generate response grounded in context

## Vector Databases

| Database | Type | Best For |
|----------|------|----------|
| **Pinecone** | Managed | Production scale |
| **Chroma** | Open source | Quick prototypes |
| **Weaviate** | Open source | Hybrid search |
| **Qdrant** | Open source | Performance |
| **Milvus** | Open source | Enterprise |

## Embedding Models

| Model | Dimensions | Quality |
|-------|------------|---------|
| text-embedding-3-large | 3072 | Excellent |
| text-embedding-3-small | 1536 | Good |
| BGE-large | 1024 | Very Good |
| E5-large | 1024 | Very Good |

## Advanced RAG Techniques

### Hybrid Search
Combine vector search with keyword search (BM25).

### Reranking
Score retrieved documents with a cross-encoder for better relevance.

### Query Transformation
- **HyDE**: Generate hypothetical answer, search for similar docs
- **Multi-query**: Generate multiple query variations

### Chunking Strategies
- Fixed size chunks
- Semantic chunking
- Hierarchical (parent-child)

## Challenges

- ❌ Retrieved context may be irrelevant
- ❌ Long context can confuse the model
- ❌ Chunking can break important context
- ❌ Embedding quality varies by domain

## Related Concepts

- [Embeddings](/knowledge/embeddings) - Vector representations
- [Context Length](/knowledge/context-length) - How much context fits
- [Agents](/knowledge/agents) - Dynamic RAG systems
