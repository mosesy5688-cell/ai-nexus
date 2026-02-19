/**
 * Markdown Controller V16.2
 * Client-side logic for MarkdownRenderer
 */

export function initMarkdownCopy() {
    // 1. Process existing buttons (from MarkdownRenderer)
    document.querySelectorAll('.markdown-copy-btn').forEach(btn => {
        if (btn.getAttribute('data-init')) return;
        btn.setAttribute('data-init', 'true');

        btn.addEventListener('click', async () => {
            const b = btn;
            const code = b.dataset.code || b.closest('.relative')?.querySelector('code')?.textContent || '';
            const text = b.querySelector('.btn-text');
            const icon = b.querySelector('.btn-icon');

            try {
                await navigator.clipboard.writeText(code);
                if (text) text.textContent = 'Done!';
                if (icon) icon.textContent = '✅';

                b.classList.add('bg-emerald-500/50', 'border-emerald-500/50');

                setTimeout(() => {
                    if (text) text.textContent = 'Copy';
                    if (icon) icon.textContent = '📋';
                    b.classList.remove('bg-emerald-500/50', 'border-emerald-500/50');
                }, 2000);
            } catch (err) {
                console.error('Copy failed', err);
            }
        });
    });

    // 2. Dynamic Injection for raw HTML or missing buttons
    document.querySelectorAll('pre').forEach(pre => {
        if (pre.closest('.relative.group') || pre.querySelector('.markdown-copy-btn')) return;

        const code = pre.querySelector('code');
        if (!code) return;

        pre.style.position = 'relative';
        const btn = document.createElement('button');
        btn.className = 'absolute top-2 right-2 p-2 bg-gray-800/50 hover:bg-gray-700/80 text-white rounded-md opacity-0 hover:opacity-100 transition-all border border-gray-600/30 backdrop-blur-sm z-10';
        btn.innerHTML = '<span class="btn-icon text-sm">📋</span>';
        btn.title = 'Copy code';

        // Add hover effect to parent pre
        pre.classList.add('group');
        btn.classList.add('group-hover:opacity-100');

        btn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(code.textContent || '');
                btn.innerHTML = '<span class="text-sm">✅</span>';
                btn.classList.add('bg-emerald-500/50');
                setTimeout(() => {
                    btn.innerHTML = '<span class="text-sm">📋</span>';
                    btn.classList.remove('bg-emerald-500/50');
                }, 2000);
            } catch (e) { }
        });

        pre.appendChild(btn);
    });
}

export function resolveImageUrls() {
    const containers = document.querySelectorAll('.markdown-content');
    containers.forEach(container => {
        const images = container.querySelectorAll('img');
        const repoPath = document.querySelector('[data-repo-path]')?.getAttribute('data-repo-path');

        images.forEach(img => {
            const src = img.getAttribute('src') || '';
            if (src && !src.startsWith('http') && !src.startsWith('data:') && repoPath) {
                const rawUrl = `https://huggingface.co/${repoPath}/resolve/main/${src.replace(/^\//, '')}`;
                img.setAttribute('src', rawUrl);
            }

            img.classList.add('cursor-zoom-in');
            img.addEventListener('click', () => {
                window.open(img.src, '_blank');
            });
        });
    });
}

const KNOWLEDGE_TERMS = {
    // LLM Basics
    'MMLU': 'Massive Multitask Language Understanding - a benchmark for general intelligence.',
    'HumanEval': 'Coding benchmark by OpenAI to test Python generation capabilities.',
    'RAG': 'Retrieval-Augmented Generation - connecting LLMs to external data sources.',
    'Quantization': 'Compression technique (GGUF/AWQ) to run large models on consumer GPUs.',
    'VRAM': 'Video RAM - the memory required on your GPU to load model weights.',
    'Context Length': 'The maximum number of tokens a model can process in one go.',
    'FNI': 'Fair Nexus Index - our proprietary trust and transparency score.',
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

export function initSmartTooltips() {
    const containers = document.querySelectorAll('.markdown-content');
    containers.forEach(container => {
        if (container.getAttribute('data-tooltips') === 'true') return;

        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
        let nodesToReplace = [];
        let currentNode;

        while (currentNode = walker.nextNode()) {
            const text = currentNode.textContent || '';
            let hasMatch = false;

            Object.keys(KNOWLEDGE_TERMS).forEach(term => {
                if (new RegExp(`\\b${term}\\b`, 'i').test(text)) {
                    hasMatch = true;
                }
            });

            if (hasMatch && currentNode.parentElement?.tagName !== 'A' && currentNode.parentElement?.tagName !== 'CODE' && currentNode.parentElement?.tagName !== 'PRE') {
                nodesToReplace.push(currentNode);
            }
        }

        nodesToReplace.forEach(node => {
            let text = node.textContent || '';
            let html = text;

            Object.entries(KNOWLEDGE_TERMS).forEach(([term, desc]) => {
                const regex = new RegExp(`\\b(${term})\\b`, 'gi');
                html = html.replace(regex, `<span class="knowledge-tooltip cursor-help border-b border-dotted border-indigo-400/50 text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 transition-colors" title="${desc}">$1</span>`);
            });

            if (html !== text) {
                const span = document.createElement('span');
                span.innerHTML = html;
                node.parentNode?.replaceChild(span, node);
            }
        });

        container.setAttribute('data-tooltips', 'true');
    });
}
