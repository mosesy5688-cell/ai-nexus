/**
 * Readme Controller - V25.1
 * Extracted from FullReadmeSection.astro for CES compliance.
 * Handles VFS Recovery, Expansion Toggles, and Markdown Copy initialization.
 */
import { runNeuralMining } from './neural-miner.js';
import { initSearch, performSearch } from './home-search.js';
import { fetchBundleRange } from '../utils/vfs-fetcher.ts';
import { initMarkdownCopy } from './markdown-controller.js';
import { marked } from 'marked';
import { sanitizeHtml } from '../utils/sanitize-client.js';

export function runReadmeController() {
  initVfsRecovery();
  initMarkdownCopy();
}

async function initVfsRecovery() {
  const section = document.getElementById('technical-readme');
  const target = document.getElementById('readme-content-target');
  const status = document.getElementById('readme-status');
  const footer = document.getElementById('readme-footer-container');
  
  if (!section || !target) return;
  if (section.dataset.hasInitial === 'true') {
    setupToggle();
    return;
  }

  const modelId = section.dataset.modelId;
  const modelType = section.dataset.modelType;
  if (!modelId) return;

  if (status) status.classList.remove('hidden');

  try {
    console.log(`[VFS-Recovery] Attempting metadata recovery for: ${modelId}`);
    await initSearch();

    const query = modelId.split('--').pop(); 
    const results = await performSearch(query, 10, { entityType: modelType });
    const record = results.find(r => r.id === modelId || r.slug === modelId);

    if (record && record.bundle_key) {
      console.log(`[VFS-Recovery] Found shard mapping: ${record.bundle_key} @ ${record.bundle_offset}`);
      const bundle = await fetchBundleRange(record.bundle_key, record.bundle_offset, record.bundle_size);
      
      if (bundle && (bundle.html_readme || bundle.readme)) {
        const rawHtml = bundle.html_readme || await marked(bundle.readme || '');
        const html = sanitizeHtml(rawHtml);
        target.innerHTML = `<div class="markdown-content prose prose-sm md:prose-base dark:prose-invert max-w-none 
                                  prose-headings:font-black prose-headings:tracking-tight prose-headings:text-zinc-900 dark:prose-headings:text-white
                                  prose-a:text-[#bdc3ff] prose-a:font-bold prose-a:no-underline hover:prose-a:underline
                                  prose-strong:text-zinc-900 dark:prose-strong:text-white
                                  leading-relaxed tracking-tight">${html}</div>`;
        section.dataset.hasInitial = 'true';
        if (html.length > 5000) footer?.classList.remove('hidden');
        setupToggle();
        initMarkdownCopy();
        runNeuralMining(target);
        console.log(`[VFS-Recovery] Recovery SUCCESS.`);
      }
    } else {
       console.warn(`[VFS-Recovery] No shard mapping found in VFS for ${modelId}`);
       target.innerHTML = `<p class="text-zinc-400 text-sm italic">Documentation currently synchronized with local index. Full specifications available via production mirror.</p>`;
    }
  } catch (e) {
    console.error(`[VFS-Recovery] Recovery Error:`, e);
  } finally {
    if (status) status.classList.add('hidden');
  }
}

function setupToggle() {
  const toggleBtn = document.getElementById('toggle-readme');
  const container = document.getElementById('readme-container');
  const fade = document.getElementById('readme-fade');
  const topToggle = document.getElementById('readme-toggle-top');
  
  if (toggleBtn && container) {
    const typeLabel = toggleBtn.getAttribute('data-type-label') || 'Card';
    
    const toggle = () => {
      const isExpanded = toggleBtn.dataset.expanded === 'true';
      if (isExpanded) {
        container.classList.add('collapsed');
        if (fade) fade.style.opacity = '1';
        toggleBtn.dataset.expanded = 'false';
        const text = toggleBtn.querySelector('.toggle-text');
        if (text) text.textContent = `Expand full ${typeLabel}`;
        const icon = toggleBtn.querySelector('.toggle-icon');
        if (icon) icon.classList.remove('rotate-180');
        const line = toggleBtn.querySelector('.toggle-line');
        if (line) line.classList.remove('opacity-0');
        
        if (topToggle) {
           const topText = topToggle.querySelector('.toggle-text');
           if (topText) topText.textContent = 'Full Specifications';
        }
        
        container.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        container.classList.remove('collapsed');
        if (fade) fade.style.opacity = '0';
        toggleBtn.dataset.expanded = 'true';
        const text = toggleBtn.querySelector('.toggle-text');
        if (text) text.textContent = 'Show Less';
        const icon = toggleBtn.querySelector('.toggle-icon');
        if (icon) icon.classList.add('rotate-180');
        const line = toggleBtn.querySelector('.toggle-line');
        if (line) line.classList.add('opacity-0');

        if (topToggle) {
           const topText = topToggle.querySelector('.toggle-text');
           if (topText) topText.textContent = 'Show Summary';
        }
      }
    };

    toggleBtn.addEventListener('click', toggle);
    if (topToggle) topToggle.addEventListener('click', toggle);
  }
}
