---
layout: ../../layouts/KnowledgeLayout.astro
title: What is Tokenization?
slug: tokenization
description: How language models convert text into numbers they can process
keywords: tokenization, bpe, wordpiece, sentencepiece, vocabulary, subword
---

# What is Tokenization?

**Tokenization** is the process of converting text into discrete units (tokens) that language models can process. It's the first step in any NLP pipeline and directly impacts model performance, vocabulary size, and multilingual capability.

## Why Tokenization Matters

Language models work with numbers, not text. Tokenization bridges this gap:

```
"Hello, world!" → [15496, 11, 1917, 0] → Model → [output tokens] → "Response"
```

## Tokenization Methods

### 1. Word-Level
Splits on whitespace and punctuation.
- ❌ Huge vocabulary (100K+ words)
- ❌ Can't handle unknown words
- ❌ Poor for morphologically rich languages

### 2. Character-Level
Each character is a token.
- ✅ Small vocabulary
- ❌ Very long sequences
- ❌ Loses word-level meaning

### 3. Subword (Modern Standard)
Balances vocabulary size and sequence length.

| Algorithm | Used By |
|-----------|---------|
| **BPE** (Byte-Pair Encoding) | GPT, LLaMA |
| **WordPiece** | BERT, DistilBERT |
| **Unigram** | T5, XLNet |
| **SentencePiece** | Many multilingual models |

## Byte-Pair Encoding (BPE)

The most popular subword method:

1. Start with character vocabulary
2. Find most frequent character pair
3. Merge into new token
4. Repeat until desired vocabulary size

Example:
```
"lower" → ["l", "o", "w", "e", "r"]
After BPE: ["low", "er"]
```

## Vocabulary Size Trade-offs

| Size | Pros | Cons |
|------|------|------|
| Small (32K) | Longer sequences, more compute | Better generalization |
| Large (128K) | Shorter sequences, less compute | Larger embedding matrix |

## Tokenization Efficiency

Different languages tokenize differently:

| Language | Tokens for "Hello, how are you?" |
|----------|----------------------------------|
| English | ~6 tokens |
| Chinese | ~12 tokens |
| Japanese | ~15 tokens |

This affects context length and cost for non-English users.

## Special Tokens

| Token | Purpose |
|-------|---------|
| `<BOS>` | Beginning of sequence |
| `<EOS>` | End of sequence |
| `<PAD>` | Padding for batching |
| `<UNK>` | Unknown token |
| `<MASK>` | For masked language modeling |

## Related Concepts

- [Context Length](/knowledge/context-length) - How tokens affect input limits
- [Transformer](/knowledge/transformer) - Architecture that processes tokens
