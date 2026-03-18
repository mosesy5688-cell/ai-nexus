/**
 * ArXiv Taxonomy Mapping - V1.0
 * Comprehensive dictionary of ArXiv categories for synthetic Hub pages.
 */

export const ARXIV_TAXONOMY = {
    // Computer Science
    'cs.AI': { label: 'Artificial Intelligence', icon: '🤖', color: '#6366f1' },
    'cs.LG': { label: 'Machine Learning', icon: '🧠', color: '#8b5cf6' },
    'cs.CL': { label: 'Computation and Language', icon: '🗣�?, color: '#10b981' },
    'cs.CV': { label: 'Computer Vision', icon: '👁�?, color: '#f59e0b' },
    'cs.NE': { label: 'Neural and Evolutionary Computing', icon: '🧬', color: '#ef4444' },
    'cs.RO': { label: 'Robotics', icon: '🦾', color: '#64748b' },
    'cs.IR': { label: 'Information Retrieval', icon: '🔍', color: '#06b6d4' },
    'cs.GT': { label: 'Computer Science and Game Theory', icon: '🎮', color: '#ec4899' },
    'cs.CY': { label: 'Computers and Society', icon: '⚖️', color: '#71717a' },
    'cs.CR': { label: 'Cryptography and Security', icon: '🛡�?, color: '#3f3f46' },
    'cs.DC': { label: 'Distributed, Parallel, and Cluster Computing', icon: '⛓️', color: '#14b8a6' },
    'cs.DS': { label: 'Data Structures and Algorithms', icon: '🧱', color: '#f97316' },

    // Statistics
    'stat.ML': { label: 'Machine Learning (Stat)', icon: '📉', color: '#8b5cf6' },
    'stat.AP': { label: 'Applied Statistics', icon: '📊', color: '#0ea5e9' },
    'stat.ME': { label: 'Methodology', icon: '📐', color: '#6366f1' },
    'stat.TH': { label: 'Statistics Theory', icon: '📑', color: '#4b5563' },

    // Mathematics
    'math.CO': { label: 'Combinatorics', icon: '🧩', color: '#fbbf24' },
    'math.ST': { label: 'Statistics Theory (Math)', icon: '📉', color: '#4f46e5' },
    'math.LO': { label: 'Logic', icon: '🧮', color: '#334155' },

    // Physics & Others
    'astro-ph.CO': { label: 'Cosmology and Nongalactic Astrophysics', icon: '🌌', color: '#1e1b4b' },
    'cond-mat.stat-mech': { label: 'Statistical Mechanics', icon: '🔥', color: '#7c2d12' },
    'quant-ph': { label: 'Quantum Physics', icon: '⚛️', color: '#0369a1' },

    // Group Fallbacks
    'cs': { label: 'Computer Science', icon: '💻', color: '#334155' },
    'stat': { label: 'Statistics', icon: '📊', color: '#0891b2' },
    'math': { label: 'Mathematics', icon: '📐', color: '#4338ca' },
    'physics': { label: 'Physics', icon: '⚛️', color: '#111827' }
};

export function getCategoryMeta(id) {
    if (!id) return null;
    const norm = id.toLowerCase().replace('arxiv:', '').replace('arxiv--', '');

    // Exact match
    if (ARXIV_TAXONOMY[norm]) return ARXIV_TAXONOMY[norm];

    // Group match (e.g. cs.AI -> cs)
    const group = norm.split('.')[0];
    if (ARXIV_TAXONOMY[group]) return ARXIV_TAXONOMY[group];

    return { label: norm.toUpperCase(), icon: '📁', color: '#9ca3af' };
}
