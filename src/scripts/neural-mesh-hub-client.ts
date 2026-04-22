/**
 * Neural Mesh Hub Client Hydration
 * CES-extracted from NeuralGraphExplorer.astro to keep the component ≤250 lines.
 *
 * Responsibilities:
 *  - Hydrate SSR-Lite hub (when server-side rendered < full mesh to protect OOM)
 *  - Validate hub has nodes and hide empty wrapper
 *  - Wire "show more" fold buttons
 */
import { escapeHtml } from '../utils/escape-html.js';

/** Guard: only register global Astro lifecycle listeners once to prevent N executions after N navigations */
let _meshHubInitialized = false;

async function hydrateMeshHub(): Promise<void> {
    const hub = document.getElementById('neural-mesh-hub');
    if (!hub) return;

    const rootId = hub.dataset.rootId || '';
    const nodes = hub.querySelectorAll('.mesh-node');

    // Hydrate if SSR was forced into 'lite' mode or if the mesh is missing
    const isLite = hub.dataset.ssrLite === 'true';
    if (!(nodes.length <= 1 || isLite)) return;

    console.log('[NeuralMesh] Hydration triggered (Lite:', isLite, ') for:', rootId);
    try {
        const { getMeshProfile } = await import('../utils/mesh-orchestrator.js');
        const { getRouteFromId } = await import('../utils/mesh-routing-core.js');

        const profile = await getMeshProfile(null as any, rootId, null, { ssrOnly: false } as any);
        if (!profile || !profile.tiers) return;

        Object.entries(profile.tiers).forEach(([key, tier]: [string, any]) => {
            if (!tier.nodes || tier.nodes.length === 0) return;

            const grid = document.getElementById(`mesh-grid-${key}`);
            if (!grid) return;

            grid.innerHTML = tier.nodes.map((node: any, index: number) => {
                const path = getRouteFromId(node.slug || node.id, node.type);
                const isExtra = index >= 6 ? 'hidden extra-node' : '';
                const relationBadge = node.relation ? `
                    <span class="relation-badge absolute -top-2 -right-2 px-1.5 py-0.5 bg-indigo-500 text-[8px] font-black text-white rounded shadow-sm uppercase tracking-tighter overflow-hidden">
                      ${escapeHtml(node.relation)}
                      ${node.match_score ? `<span class="ml-1 opacity-70 border-l border-white/20 pl-1">${node.match_score}%</span>` : ''}
                    </span>` : '';

                return `
                  <a href="${path}" class="mesh-node group relative p-4 bg-white dark:bg-gray-800/40 border border-gray-100 dark:border-gray-700/50 rounded-2xl hover:border-indigo-500/50 hover:shadow-xl hover:shadow-indigo-500/5 transition-all duration-300 ${isExtra}">
                    <div class="flex items-start gap-4">
                      <div class="node-icon-wrapper relative">
                        <span class="text-3xl filter grayscale group-hover:grayscale-0 transition-all duration-500 block">${escapeHtml(node.icon || '📦')}</span>
                        ${relationBadge}
                      </div>
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center justify-between gap-2 mb-1">
                          <span class="text-sm font-bold text-gray-900 dark:text-white truncate group-hover:text-indigo-500 transition-colors">${escapeHtml(node.name)}</span>
                          <span class="text-[8px] font-black uppercase tracking-tighter px-1.5 py-0.5 rounded bg-gray-50 dark:bg-gray-900 text-gray-400 border border-gray-100 dark:border-gray-800">${escapeHtml(node.type)}</span>
                        </div>
                        <p class="text-[10px] text-gray-500 dark:text-gray-400 line-clamp-1">${escapeHtml(node.author || 'Ecosystem Node')}</p>
                      </div>
                      <div class="flex flex-col justify-center opacity-30 group-hover:opacity-100 transition-opacity">
                        <span class="text-indigo-500 translate-x-0 group-hover:translate-x-1 transition-transform">→</span>
                      </div>
                    </div>
                  </a>`;
            }).join('');

            const tierContainer = grid.closest('.mesh-tier') as HTMLElement | null;
            if (tierContainer) tierContainer.style.display = 'block';
        });

        validateMeshHub();
        initFolding();
    } catch (e: any) {
        console.warn('[NeuralMesh] Hydration failed:', e?.message);
    }
}

function validateMeshHub(): void {
    const hub = document.getElementById('neural-mesh-hub');
    if (!hub) return;

    const wrapper = hub.closest('.neural-graph-wrapper') as HTMLElement | null;
    if (!wrapper) return;

    const nodes = hub.querySelectorAll('.mesh-node');
    if (nodes.length === 0) {
        wrapper.style.display = 'none';
        console.warn('[NeuralMesh] Hub stability guard triggered: Zero nodes.');
    } else {
        wrapper.style.display = 'block';
    }
}

function initFolding(): void {
    const buttons = document.querySelectorAll<HTMLButtonElement>('.show-more-nodes-btn');
    buttons.forEach(btn => {
        if (btn.dataset.hasListener) return;
        btn.dataset.hasListener = 'true';

        btn.addEventListener('click', () => {
            const targetId = btn.dataset.target;
            if (!targetId) return;
            const grid = document.getElementById(targetId);
            if (!grid) return;

            const extra = grid.querySelectorAll<HTMLElement>('.extra-node');
            if (extra.length === 0) return;
            extra.forEach(el => el.classList.toggle('hidden'));

            const isHidden = extra[0].classList.contains('hidden');
            const span = btn.querySelector('span');
            if (span) {
                span.textContent = isHidden
                    ? `+ Expand ${extra.length} Hidden Relations`
                    : '- Collapse View';
            }
        });
    });
}

export function initNeuralMeshHub(): void {
    hydrateMeshHub().then(() => validateMeshHub());
    initFolding();

    // Only register global Astro lifecycle listeners once to prevent stacking on repeated navigations
    if (_meshHubInitialized) return;
    _meshHubInitialized = true;

    document.addEventListener('astro:after-swap', () => {
        hydrateMeshHub().then(() => validateMeshHub());
        initFolding();
    });
    document.addEventListener('astro:page-load', () => {
        hydrateMeshHub().then(() => validateMeshHub());
        initFolding();
    });
}
