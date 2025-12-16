
// src/scripts/filters-client.js

export function initializeFilters() {
    const filtersEl = document.getElementById('explore-filters');

    if (filtersEl) {
        // Family chips toggle
        document.querySelectorAll('.chip[data-family]').forEach(chip => {
            chip.addEventListener('click', () => {
                chip.classList.toggle('active');
            });
        });

        // Range slider value display (MMLU)
        const mmluInput = document.getElementById('mmlu-min');
        const mmluValue = document.getElementById('mmlu-value');
        if (mmluInput && mmluValue) {
            mmluInput.addEventListener('input', (e) => {
                mmluValue.textContent = `${e.target.value}%`;
            });
        }

        // Range slider value display (Deploy Score)
        const deployInput = document.getElementById('deploy-min');
        const deployValue = document.getElementById('deploy-value');
        if (deployInput && deployValue) {
            deployInput.addEventListener('input', (e) => {
                deployValue.textContent = `${e.target.value}%`; // Note: Logic said value/100, but display is %, input is 0-100 likely
            });
        }

        // Reset filters
        document.getElementById('reset-filters')?.addEventListener('click', () => {
            window.location.href = '/explore';
        });

        // Apply filters
        document.getElementById('apply-filters')?.addEventListener('click', () => {
            const params = new URLSearchParams();

            // Families
            const selectedFamilies = [];
            document.querySelectorAll('.chip.active[data-family]').forEach(chip => {
                selectedFamilies.push(chip.dataset.family);
            });
            if (selectedFamilies.length > 0) {
                params.set('family', selectedFamilies.join(','));
            }

            // Params (Size) - Assuming simple select now, reused logic if complex
            const size = document.getElementById('size-filter').value;
            if (size) params.set('size', size);

            // Context
            const context = document.getElementById('context-filter').value;
            if (context) params.set('context', context);

            // Benchmarks Toggle
            const hasBenchmarks = document.getElementById('benchmarks-toggle').checked;
            if (hasBenchmarks) params.set('benchmarks', 'true');

            // MMLU Min
            const mmluMin = document.getElementById('mmlu-min').value;
            if (mmluMin > 0) {
                params.set('mmlu_min', mmluMin);
            }

            // Deploy Score (0-100 in slider, mapped to 0-1.0 in URL usually? Or keep consistent)
            // Original code: params.set('deploy_min', (deployMin / 100).toFixed(2));
            const deployMin = document.getElementById('deploy-min').value;
            if (deployMin > 0) {
                params.set('deploy_min', (deployMin / 100).toFixed(2));
            }

            // Sort
            const sort = document.getElementById('sort-filter').value;
            if (sort !== 'fni') { // Default check
                params.set('sort', sort);
            }

            // Navigate
            window.location.href = `/explore?${params.toString()}`;
        });
    }
}
