
import { deriveEntityType } from '../src/data/entity-definitions.ts';

const testCases = [
    { id: 'meta-llama/Llama-3-8B', expected: 'model' },
    { id: 'lavague-ai/lavague', expected: 'agent' },
    { id: 'sciphi-ai/r2r', expected: 'agent' },
    { id: 'ncnn', expected: 'tool' }, // Since ncnn is often called a framework/tool
    { id: 'arxiv:1234.5678', expected: 'paper' },
    { id: 'knowledge--rag', expected: 'knowledge' } // Wait, knowledge-- is just prefix
];

testCases.forEach(tc => {
    const result = deriveEntityType({ id: tc.id });
    const success = result.type === tc.expected;
    console.log(`[${success ? 'PASS' : 'FAIL'}] ID: ${tc.id.padEnd(30)} -> Type: ${result.type.padEnd(10)} Icon: ${result.definition.display.icon}`);
});
