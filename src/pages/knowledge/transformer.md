---
layout: ../../layouts/KnowledgeLayout.astro
title: Transformer Architecture
slug: transformer
description: The foundational architecture behind modern Large Language Models like GPT-4, Llama, and Claude
keywords: transformer, self-attention, architecture, neural networks, llm fundamentals
---

# What is a Transformer?

The **Transformer** is a deep learning architecture introduced by Google researchers in the 2017 paper *"Attention Is All You Need"*. It revolutionized natural language processing (NLP) by replacing previous sequential models (like RNNs and LSTMs) with a parallelizable structure based entirely on **Attention Mechanisms**.

## Core Components

The Transformer architecture consists of two main parts: the **Encoder** and the **Decoder**. Modern LLMs like Llama 3 are typically **Decoder-only**, while models like T5 or BERT use either both or just the Encoder.

### 1. Self-Attention (The Secret Sauce)
Self-attention allows the model to look at other words in a sentence to get a better understanding of the word in context.
-   **Example**: In the sentence *"The animal didn't cross the street because **it** was too tired"*, self-attention helps the model realize "**it**" refers to the **animal**.

### 2. Multi-Head Attention
Instead of one set of attention weights, the model uses multiple "heads" to learn different types of relationships simultaneously (e.g., one head for grammar, another for factual associations).

### 3. Positional Encoding
Since Transformers process all words at once (unlike humans who read left-to-right), they need a way to know the *order* of words. Positional encoding adds a unique signal to each word's embedding indicating its position in the sequence.

## Architecture Visual Breakdown

| Layer Type | Purpose |
| :--- | :--- |
| **Input Embedding** | Converts text into numerical vectors |
| **Positional Encoding** | Retains word order information |
| **Attention Layers** | Captures relationships between words |
| **Feed-Forward Layers** | Processes information independently for each word |
| **Output Layer** | Predicts the probability of the next word |

## Key Milestones

1.  **2017**: Google publishes *"Attention Is All You Need"*.
2.  **2018**: BERT (Encoder-only) and GPT (Decoder-only) are released.
3.  **2020**: GPT-3 proves that scaling Transformers leads to emergent reasoning.
4.  **2023-24**: Llama, Mixtral, and Claude push the limits of efficiency and context length.

## Why It Won

-   **Parallelization**: Unlike older models, Transformers can process entire sentences at once, making them much faster to train on massive hardware.
-   **Long-Range Dependencies**: They can "see" relationships between words tens of thousands of tokens apart.
-   **Scalability**: They continue to get smarter as you add more parameters and data.

## Related Concepts

-   [Self-Attention](/knowledge/attention) - Deep dive into how models "focus".
-   [Tokenization](/knowledge/tokenization) - How text becomes data for the Transformer.
-   [Mixture of Experts (MoE)](/knowledge/moe) - Scaling Transformers with switchable layers.
-   [Flash Attention](/knowledge/flash-attention) - Optimizing Transformer memory usage.
