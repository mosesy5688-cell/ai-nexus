function checkValidation(entity, model) {
    const hasIdentity = entity.name || model?.name;
    const hasContent = entity.source_url || entity.description?.length > 10 || entity.fni_score > 0;
    const isValidEntity = entity && hasIdentity && hasContent;
    return isValidEntity;
}

const mockCases = [
    {
        name: 'Broken Shard (Name Only)',
        entity: { name: 'Coqui XTTS v2' },
        model: { name: 'Coqui XTTS v2' },
        expected: false
    },
    {
        name: 'Valid Model',
        entity: { name: 'Llama 3', source_url: 'https://hf.co/meta-llama/llama-3' },
        model: { name: 'Llama 3' },
        expected: true
    },
    {
        name: 'Knowledge Node (No Source, but Description)',
        entity: { name: 'AWQ', description: 'Activation-aware Weight Quantization is a technical...' },
        model: { name: 'AWQ' },
        expected: true
    }
];

mockCases.forEach(c => {
    const result = checkValidation(c.entity, c.model);
    console.log(`Case: ${c.name} -> Valid: ${result} (Expected: ${c.expected})`);
});
