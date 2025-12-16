
// src/scripts/compare-client.js
export function initComparePage() {
    const btn = document.getElementById('compare-btn');
    if (btn) {
        btn.addEventListener('click', () => {
            const selects = document.querySelectorAll('.model-select');
            const selectedModels = [];

            selects.forEach(select => {
                if (select.value) {
                    selectedModels.push(select.value);
                }
            });

            if (selectedModels.length >= 2) {
                const params = selectedModels.map(m => `m=${encodeURIComponent(m)}`).join('&');
                window.location.href = `/compare?${params}`;
            } else {
                alert('Please select at least 2 models to compare');
            }
        });
    }
}
