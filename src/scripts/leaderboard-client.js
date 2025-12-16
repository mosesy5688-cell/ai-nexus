
// src/scripts/leaderboard-client.js
export function initializeLeaderboard() {
    const familyFilter = document.getElementById('family-filter');
    const sizeFilter = document.getElementById('min-size-filter');
    const tableRows = document.querySelectorAll('.benchmark-row'); // Assuming table component uses this class

    function filterTable() {
        const family = familyFilter?.value.toLowerCase();
        const minSize = parseInt(sizeFilter?.value || '0');

        tableRows.forEach(row => {
            const rowFamily = row.dataset.family || '';
            const rowSize = parseFloat(row.dataset.size || '0');

            const matchesFamily = !family || rowFamily.includes(family);
            const matchesSize = rowSize >= minSize;

            if (matchesFamily && matchesSize) {
                row.style.display = '';
            } else {
                row.style.display = 'none';
            }
        });
    }

    if (familyFilter) familyFilter.addEventListener('change', filterTable);
    if (sizeFilter) sizeFilter.addEventListener('change', filterTable);
}
