/**
 * Knowledge Terms Dictionary V16.2
 * Extracted from markdown-controller.js for CES Art 5.1 compliance.
 * Used by initSmartTooltips() to add hover definitions to technical terms.
 */

export const KNOWLEDGE_TERMS = {
    // LLM Basics
    'MMLU': 'Massive Multitask Language Understanding - a benchmark for general intelligence.',
    'HumanEval': 'Coding benchmark by OpenAI to test Python generation capabilities.',
    'RAG': 'Retrieval-Augmented Generation - connecting LLMs to external data sources.',
    'Quantization': 'Compression technique (GGUF/AWQ) to run large models on consumer GPUs.',
    'VRAM': 'Video RAM - the memory required on your GPU to load model weights.',
    'Context Length': 'The maximum number of tokens a model can process in one go.',
    'FNI': 'Free2AITools Nexus Index - our proprietary trust and transparency score.',
    'Transformer': 'The core neural network architecture behind all modern LLMs.',
    'Token': 'The basic unit of text processing in LLMs, roughly 0.75 words.',
    'Parameters': 'The "neurons" of a model; more parameters usually mean higher intelligence.',

    // Model Types & Architectures
    'LLM': 'Large Language Model - AI trained on vast amounts of text.',
    'MoE': 'Mixture of Experts - architecture that uses only parts of the model for each query (efficient).',
    'GGUF': 'Unified format for running LLMs on CPUs and consumer hardware.',
    'LoRA': 'Low-Rank Adaptation - a technique for lightweight fine-tuning of models.',
    'SFT': 'Supervised Fine-Tuning - training a model on specific instruction-following data.',
    'RLHF': 'Reinforcement Learning from Human Feedback - aligning models with human preferences.',
    'Multimodal': 'Models that can process multiple data types (Text, Image, Audio).',

    // Agentic Frameworks
    'Agent': 'An AI system that can use tools and make autonomous decisions to achieve goals.',
    'Orchestration': 'The process of managing multiple AI agents or tools in a sequence.',
    'Chain of Thought': 'Prompting technique where the model explains its reasoning step-by-step.',
    'MCP': 'Model Context Protocol - open standard for connecting AI to your local data.',
    'Tool Use': 'Capability of a model to call external APIs or execute code (Function Calling).',

    // Evaluation Metrics
    'GSM8K': 'Grade School Math 8K - benchmark for mathematical reasoning.',
    'HellaSwag': 'Benchmark for common sense reasoning and sentence completion.',
    'ARC': 'AI2 Reasoning Challenge - tests scientific knowledge and reasoning.',
    'TruthfulQA': 'Benchmark for detecting hallucinations and misinformation.',
    'MBPP': 'Mostly Basic Python Problems - code generation benchmark.',

    // Infrastructure & Ops
    'Latency': 'The time delay between a prompt being sent and the response starting.',
    'TPOT': 'Tokens Per Output Token - time taken to generate each subsequent token.',
    'TTFT': 'Time To First Token - time taken to start the response after a prompt.',
    'Throughput': 'Number of tokens generated per second across all users.',
    'Inference': 'The process of running a trained model to generate predictions.',

    // Ethics & Safety
    'Hallucination': 'When an AI generates plausible-sounding but factually incorrect information.',
    'Alignment': 'The goal of making AI systems follow human intent and safety rules.',
    'Jailbreak': 'Bypassing an AI\'s safety filters through clever prompting.',
    'Data Contamination': 'When test data is accidentally included in a model\'s training set.',

    // Emerging Trends
    'Distillation': 'Training a smaller model to mimic the performance of a much larger one.',
    'Speculative Decoding': 'Method to speed up inference using a smaller "draft" model.',
    'Embedding': 'Numerical representation of text used for semantic search and RAG.',
    'Vector Database': 'Specialized database for storing and searching high-dimensional embeddings.'
};
