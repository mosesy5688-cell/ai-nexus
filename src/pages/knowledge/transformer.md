---
layout: ../../layouts/KnowledgeLayout.astro
title: Transformer Architecture
slug: transformer
---

# Transformer Architecture

The Transformer is the foundational architecture behind modern large language models (LLMs).

## Key Components

### Self-Attention Mechanism

The core innovation that allows the model to look at all positions in the input sequence simultaneously:

```
Attention(Q, K, V) = softmax(QK^T / √d_k) V
```

- **Q (Query)**: What we're looking for
- **K (Key)**: What we're matching against
- **V (Value)**: The information we retrieve

### Multi-Head Attention

Multiple attention heads allow the model to focus on different aspects:

```
MultiHead(Q, K, V) = Concat(head_1, ..., head_h) W^O
```

### Feed-Forward Networks

After attention, each position goes through the same FFN:

```
FFN(x) = max(0, xW_1 + b_1)W_2 + b_2
```

## Architecture Variants

| Variant | Description | Examples |
|---------|-------------|----------|
| **Encoder-Only** | Input understanding | BERT |
| **Decoder-Only** | Text generation | GPT, LLaMA |
| **Encoder-Decoder** | Seq2seq tasks | T5, BART |

## Related Concepts

- [Mixture of Experts](/knowledge/moe)
- [Quantization](/knowledge/quantization)
- [VRAM Requirements](/knowledge/vram)
