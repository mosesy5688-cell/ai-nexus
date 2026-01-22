---
title: What is LoRA?
description: Low-Rank Adaptation - efficient fine-tuning technique for large language models
keywords: lora, qlora, fine-tuning, peft, adapters, llm training
---

# What is LoRA?

**LoRA (Low-Rank Adaptation)** is a parameter-efficient fine-tuning technique that enables training large language models with significantly reduced computational resources. Instead of updating all model parameters, LoRA freezes the pretrained weights and injects trainable low-rank matrices into each layer.

## How LoRA Works

Traditional fine-tuning updates all parameters in a weight matrix W. LoRA instead represents the weight update as:

```
W' = W + BA
```

Where:
- **W** is the original frozen weight matrix
- **B** and **A** are low-rank matrices (rank r << dimensions)
- Only B and A are trained, reducing trainable parameters by 10,000x

## Key Benefits

| Aspect | Traditional Fine-tuning | LoRA |
|--------|------------------------|------|
| Trainable Parameters | 100% | 0.01-1% |
| VRAM Required | 80+ GB | 8-24 GB |
| Training Time | Hours-Days | Minutes-Hours |
| Storage per Model | Full Copy | Small Adapter |

## QLoRA: Quantized LoRA

**QLoRA** combines LoRA with 4-bit quantization, enabling fine-tuning of 65B+ parameter models on a single consumer GPU:

- Uses 4-bit NormalFloat quantization
- Introduces double quantization for memory efficiency
- Enables fine-tuning LLaMA-65B on a single 48GB GPU

## Common Use Cases

1. **Domain Adaptation**: Specializing models for medical, legal, or technical domains
2. **Instruction Tuning**: Teaching models to follow specific formats
3. **Style Transfer**: Adapting writing style or persona
4. **Language Adaptation**: Fine-tuning for low-resource languages

## Popular Implementations

- **PEFT** (Hugging Face): Official LoRA implementation
- **Axolotl**: Easy-to-use fine-tuning framework
- **LLaMA-Factory**: Comprehensive LLM fine-tuning toolkit

## Related Concepts

- [Fine-tuning](/knowledge/fine-tuning) - General fine-tuning overview
- [Quantization](/knowledge/quantization) - Model compression techniques
- [VRAM](/knowledge/vram) - GPU memory requirements
