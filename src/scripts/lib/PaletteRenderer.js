/**
 * V23.2: Palette Result Renderer
 * Extracted from SearchCommandPalette.astro for CES Art 5.1 compliance.
 */

export function renderPaletteResults(results, container) {
    if (!container) return;

    if (results.length === 0) {
        container.innerHTML = '<div class="py-12 text-center text-white/40 text-xs">No matches found.</div>';
        return;
    }

    const now = Math.floor(Date.now() / 1000);
    const fmtTime = (secs) => {
        if (!secs) return '';
        const days = Math.floor((now - secs) / 86400);
        if (days < 1) return 'today';
        if (days < 30) return `${days}d`;
        if (days < 365) return `${Math.floor(days / 30)}mo`;
        return `${Math.floor(days / 365)}y`;
    };
    const fmtCtx = (ctx) => {
        if (!ctx) return '';
        return ctx >= 1000 ? Math.round(ctx / 1000) + 'K' : String(ctx);
    };

    container.innerHTML = results.map((r, i) => `
      <div class="result-item" data-index="${i}" onclick="window.location.href='/${r.type}/${r.slug}'">
        <div class="w-8 h-8 rounded bg-white/5 flex items-center justify-center text-[10px] font-bold text-white/40 shrink-0">
          ${String(r.type || '').substring(0, 2).toUpperCase()}
        </div>
        <div class="flex-1 min-w-0 pr-2">
          <div class="flex items-center justify-between pb-1">
            <div class="flex items-center gap-2 min-w-0 flex-1 pr-4">
              <span class="text-sm font-medium text-white/90 truncate">${r.name}</span>
              ${r.author ? `<span class="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 text-[9px] border border-blue-500/20 truncate max-w-[100px] shrink-0">${r.author}</span>` : ''}
              ${r.task ? `<span class="px-1 py-0.5 rounded bg-white/5 text-[9px] truncate max-w-[80px] shrink-0">${r.task}</span>` : ''}
            </div>
            <span class="text-[10px] font-mono text-emerald-400 shrink-0">FNI ${(r.fni_score || 0).toFixed(1)}</span>
          </div>
          <div class="hidden sm:flex items-center gap-2 text-[10px] text-white/40 font-mono overflow-hidden whitespace-nowrap">
             <span class="truncate flex-1 max-w-[140px] text-white/30" title="${r.slug}">${(r.slug || '').split('/').pop() || r.slug}</span>
             ${r.downloads ? `<span class="w-1 h-1 rounded-full bg-white/10 shrink-0"></span><span class="shrink-0">${(r.downloads / 1000).toFixed(0)}k</span>` : ''}
             ${r.context_length ? `<span class="w-1 h-1 rounded-full bg-white/10 shrink-0"></span><span class="text-purple-400 shrink-0 border border-purple-500/20 px-1 rounded-sm">${fmtCtx(r.context_length)} ctx</span>` : ''}
             ${r.license ? `<span class="w-1 h-1 rounded-full bg-white/10 shrink-0"></span><span class="text-white/50 shrink-0 truncate max-w-[80px]">${r.license}</span>` : ''}
             ${r.updated_secs || r.last_modified ? `<span class="w-1 h-1 rounded-full bg-white/10 shrink-0"></span><span class="text-amber-500/70 shrink-0">${fmtTime(r.updated_secs || (r.last_modified ? Math.floor(new Date(r.last_modified).getTime() / 1000) : 0))}</span>` : ''}
          </div>
        </div>
      </div>
    `).join('');
}
