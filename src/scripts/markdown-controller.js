/**
 * Markdown Controller V16.2
 * Client-side logic for MarkdownRenderer
 */
import { KNOWLEDGE_TERMS } from './knowledge-terms.js';

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
                if (icon) icon.textContent = 'âœ?;

                b.classList.add('bg-emerald-500/50', 'border-emerald-500/50');

                setTimeout(() => {
                    if (text) text.textContent = 'Copy';
                    if (icon) icon.textContent = 'ðŸ“‹';
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
        btn.innerHTML = '<span class="btn-icon text-sm">ðŸ“‹</span>';
        btn.title = 'Copy code';

        // Add hover effect to parent pre
        pre.classList.add('group');
        btn.classList.add('group-hover:opacity-100');

        btn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(code.textContent || '');
                btn.innerHTML = '<span class="text-sm">âœ?/span>';
                btn.classList.add('bg-emerald-500/50');
                setTimeout(() => {
                    btn.innerHTML = '<span class="text-sm">ðŸ“‹</span>';
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

// KNOWLEDGE_TERMS imported from knowledge-terms.js

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
