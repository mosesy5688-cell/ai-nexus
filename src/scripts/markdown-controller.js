/**
 * Markdown Controller V16.2
 * Client-side logic for MarkdownRenderer
 */

export function initMarkdownCopy() {
    document.querySelectorAll('.markdown-copy-btn').forEach(btn => {
        if (btn.getAttribute('data-init')) return;
        btn.setAttribute('data-init', 'true');

        btn.addEventListener('click', async () => {
            const b = btn as HTMLButtonElement;
            const code = b.dataset.code || '';
            const text = b.querySelector('.btn-text');
            const icon = b.querySelector('.btn-icon');

            try {
                await navigator.clipboard.writeText(code);
                if (text) text.textContent = 'Done!';
                if (icon) icon.textContent = '✅';

                setTimeout(() => {
                    if (text) text.textContent = 'Copy';
                    if (icon) icon.textContent = '📋';
                }, 2000);
            } catch (err) {
                console.error('Copy failed', err);
            }
        });
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
    'MMLU': 'Massive Multitask Language Understanding - a benchmark for general intelligence.',
    'HumanEval': 'Coding benchmark by OpenAI to test Python generation capabilities.',
    'RAG': 'Retrieval-Augmented Generation - connecting LLMs to external data sources.',
    'Quantization': 'Compression technique (GGUF/AWQ) to run large models on consumer GPUs.',
    'VRAM': 'Video RAM - the memory required on your GPU to load model weights.',
    'Context Length': 'The maximum number of tokens a model can process in one go.',
    'FNI': 'Fair Nexus Index - our proprietary trust and transparency score.',
    'Transformer': 'The core neural network architecture behind all modern LLMs.'
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
