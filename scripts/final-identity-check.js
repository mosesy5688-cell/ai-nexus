
// Mocking the required parts
const UNIVERSAL_ICONS = {
    'model': '🧠',
    'agent': '🤖',
    'tool': '⚙️',
    'dataset': '📊',
    'paper': '📄',
    'space': '🚀',
    'knowledge': '🎓'
};

function getTypeFromId(id) {
    if (!id || typeof id !== 'string') return 'model';
    const low = id.toLowerCase();
    if (low.includes('knowledge--') || low.includes('kb--') || low.includes('concept--')) return 'knowledge';
    if (low.includes('report--')) return 'report';
    if (low.includes('arxiv--') || low.includes('paper--') || low.match(/^arxiv:\d+/)) return 'paper';
    if (low.includes('dataset--') || low.includes('datasets/')) return 'dataset';
    if (low.includes('space--') || low.includes('spaces/')) return 'space';
    if (low.includes('agent--') || low.includes('/agents/') || low.includes('-agent-') || id.endsWith('-agent')) return 'agent';
    if (low.includes('tool--') || low.includes('/tools/') || low.includes('framework') || low.includes('library')) return 'tool';
    return 'model';
}

function deriveEntityType(id, typeHint) {
    // 0. Trust hint
    if (typeHint && UNIVERSAL_ICONS[typeHint]) return { type: typeHint, icon: UNIVERSAL_ICONS[typeHint] };

    const type = getTypeFromId(id);
    return { type, icon: UNIVERSAL_ICONS[type] || '📦' };
}

const testCases = [
    { id: 'deepseek-ai/DeepSeek-V3', hint: 'model', expected: 'model' },
    { id: 'meta-llama/Llama-3-8B', hint: 'model', expected: 'model' },
    { id: 'lavague-ai/lavague', hint: 'agent', expected: 'agent' },
    { id: 'sciphi-ai/r2r', hint: 'agent', expected: 'agent' },
    { id: 'ncnn', hint: 'tool', expected: 'tool' },
    { id: 'vLLM', hint: 'model', expected: 'model' },
    { id: 'arxiv:2305.01264', hint: 'paper', expected: 'paper' },
    { id: 'knowledge--rag', hint: 'knowledge', expected: 'knowledge' }
];

console.log("=== Identity Discovery Audit (Strategic) ===");
testCases.forEach(tc => {
    const res = deriveEntityType(tc.id, tc.hint);
    const success = res.type === tc.expected;
    console.log(`[${success ? 'PASS' : 'FAIL'}] ID: ${tc.id.padEnd(30)} Hint: ${String(tc.hint).padEnd(10)} -> Result: ${res.type.padEnd(8)} Icon: ${res.icon}`);
});
