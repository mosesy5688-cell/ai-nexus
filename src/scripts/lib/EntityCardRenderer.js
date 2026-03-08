/**
 * EntityCardRenderer.js
 * Helper for UniversalCatalog to render entity cards.
 * Extracted to ensure CES Compliance (< 250 lines per file).
 */
import { generateEntityUrl } from '../../utils/url-utils.js';
import { extractAuthor } from '../../utils/entity-utils.js';

export class EntityCardRenderer {
    static formatNumber(num) {
        if (!num) return 0;
        return new Intl.NumberFormat('en-US', { notation: "compact", maximumFractionDigits: 1 }).format(num);
    }

    static createCardHTML(item, type) {
        const id = item.id || item.slug || '';
        let baseName = item.name || '';
        if (!baseName || baseName.toLowerCase() === 'unknown') {
            baseName = id.split('/').pop()?.split('--').pop()?.replace(/--/g, '/') || 'Untitled Entity';
        }
        const displayTitle = baseName;

        const author = extractAuthor(id, item.author || item.creator || item.organization);
        const link = generateEntityUrl(item, type);

        const fni = Math.round(item.fni_score ?? item.fni ?? 0);
        const fniPercentile = item.fni_percentile || item.percentile || '';
        const pipeline_tag = item.pipeline_tag || '';

        // V23.1 Standard Colors for Badges
        const badgeColors = {
            model: 'bg-indigo-900/30 text-indigo-400 border-indigo-500/20',
            dataset: 'bg-sky-900/30 text-sky-400 border-sky-500/20',
            agent: 'bg-emerald-900/30 text-emerald-400 border-emerald-500/20',
            tool: 'bg-amber-900/30 text-amber-400 border-amber-500/20',
            space: 'bg-purple-900/30 text-purple-400 border-purple-500/20',
            paper: 'bg-rose-900/30 text-rose-400 border-rose-500/20',
            prompt: 'bg-zinc-900/30 text-zinc-400 border-zinc-500/20'
        };
        const typeBadgeColor = badgeColors[type] || badgeColors.model;
        const typeLabel = (pipeline_tag || type).replace(/-/g, ' ');

        // FNI Industrial Styling
        let fniBadgeClass = "bg-black/40 border-white/5 text-zinc-500";
        if (fni >= 85) fniBadgeClass = "bg-emerald-950/30 border-emerald-500/20 text-emerald-500";
        else if (fni >= 70) fniBadgeClass = "bg-indigo-950/30 border-indigo-500/20 text-indigo-400";
        else if (fni > 0) fniBadgeClass = "bg-zinc-900/50 border-white/10 text-white";

        return `
            <a href="${link}" class="entity-card group h-[44px] px-3 bg-[#1e1e1e] hover:bg-[#252525] border-b border-[#2a2a2a] transition-all flex items-center justify-between gap-4 overflow-hidden select-none" data-entity-id="${id}" data-entity-type="${type}">
                <!-- Column 1: Identity -->
                <div class="flex items-center gap-2 md:gap-3 flex-1 md:flex-none md:w-1/4 min-w-0">
                    <span class="text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-sm border border-white/5 shrink-0 hidden sm:inline-block sm:min-w-[65px] text-center truncate ${typeBadgeColor}">${typeLabel}</span>
                    <h3 class="text-xs font-bold text-zinc-100 group-hover:text-[#bdc3ff] transition-colors truncate" title="${displayTitle}">
                        ${displayTitle}
                    </h3>
                </div>
                
                <!-- Column 2: Specs (55%) -->
                <div class="flex-1 hidden md:flex items-center gap-6 px-4 border-l border-white/5 overflow-hidden">
                    <div class="flex items-center gap-1.5 shrink-0">
                        <span class="text-[8px] font-black text-zinc-400 uppercase tracking-widest">ARCH:</span>
                        <span class="text-[9px] font-bold text-zinc-300 truncate max-w-[120px] uppercase">${(pipeline_tag || type).replace(/-/g, ' ')}</span>
                    </div>

                    ${item.params_billions > 0 ? `
                        <div class="flex items-center gap-1.5 shrink-0">
                            <span class="text-[8px] font-black text-[#bdc3ff]/80 uppercase tracking-widest">SIZE:</span>
                            <span class="text-[10px] font-black text-[#bdc3ff] tabular-nums">${item.params_billions}B</span>
                        </div>
                    ` : ''}

                    ${item.context_length > 0 ? `
                        <div class="flex items-center gap-1.5 shrink-0 hidden lg:flex">
                            <span class="text-[8px] font-black text-zinc-400 uppercase tracking-widest">CTX:</span>
                            <span class="text-[10px] font-black text-zinc-300 tabular-nums">${item.context_length >= 1000 ? `${Math.round(item.context_length / 1000)}k` : item.context_length}</span>
                        </div>
                    ` : ''}

                    ${item.vram_est > 0 ? `
                        <div class="flex items-center gap-1.5 shrink-0 hidden lg:flex">
                            <span class="text-[8px] font-black text-emerald-500/80 uppercase tracking-widest">VRAM:</span>
                            <span class="text-[10px] font-black text-emerald-400 tabular-nums">~${item.vram_est}G</span>
                        </div>
                    ` : ''}
                </div>

                <!-- Column 3: Stats & FNI (20%) -->
                <div class="flex items-center gap-3 md:gap-5 shrink-0 justify-end md:w-[20%] font-mono">
                    <div class="flex items-center gap-4 text-[10px] font-bold text-zinc-400 uppercase tracking-widest">
                        <div class="flex items-center gap-1.5 shrink-0" title="Downloads">
                            <span class="text-zinc-300 font-black tabular-nums">${this.formatNumber(item.downloads || 0)}</span>
                            <span class="text-[12px] opacity-70">📥</span>
                        </div>
                    </div>

                    <div class="flex items-center gap-2">
                        ${fni > 0 ? `
                            <div class="flex items-center gap-2 px-2.5 py-0.5 rounded-sm border fni-badge-container ${fniBadgeClass}">
                                <span class="text-[11px] font-black tabular-nums">${fni}</span>
                                <span class="text-[8px] font-black uppercase tracking-widest opacity-60">FNI</span>
                            </div>
                        ` : ''}
                    </div>
                </div>
            </a>
        `;
    }
}
