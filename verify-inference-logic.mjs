
import { getQuickInsights, getUseCases } from './src/utils/inference.js';

console.log("🧪 Starting V15.0 Inference Logic Verification...");

const tests = [
    {
        name: "Model (LLM)",
        type: "model",
        entity: { params_billions: 7, context_length: 32768, has_gguf: true },
        tags: ['text-generation', 'pytorch'],
        check: (insights, cases) => {
            const hasParams = insights.some(i => i.label === 'Params' && i.value === '7B');
            const hasGGUF = insights.some(i => i.label === 'Format' && i.value.includes('GGUF'));
            const hasChat = cases.some(c => c.id === 'chat');
            return hasParams && hasGGUF && hasChat;
        }
    },
    {
        name: "Agent (Auto)",
        type: "agent",
        entity: { tools_count: 5, stars: 1200, framework: 'LangChain' },
        tags: [], // No tags -> should trigger default
        check: (insights, cases) => {
            const hasTools = insights.some(i => i.label === 'Tools' && i.value === 5);
            const hasAssist = cases.some(c => c.id === 'assist');
            return hasTools && hasAssist;
        }
    },
    {
        name: "Space (Demo)",
        type: "space",
        entity: { sdk: 'gradio', likes: 500 },
        tags: [],
        check: (insights, cases) => {
            const hasSDK = insights.some(i => i.label === 'SDK' && i.value === 'gradio');
            const hasDemo = cases.some(c => c.id === 'demo'); // Default inference
            return hasSDK && hasDemo;
        }
    },
    {
        name: "Tool (Dev)",
        type: "tool",
        entity: { language: 'Python', license: 'MIT' },
        tags: [],
        check: (insights, cases) => {
            const hasLang = insights.some(i => i.label === 'Lang' && i.value === 'Python');
            const hasDev = cases.some(c => c.id === 'dev'); // Default inference
            return hasLang && hasDev;
        }
    },
    {
        name: "Dataset (Train)",
        type: "dataset",
        entity: { size_gb: 50, rows: 10000 },
        tags: [],
        check: (insights, cases) => {
            const hasSize = insights.some(i => i.label === 'Size' && i.value === '50 GB');
            const hasTrain = cases.some(c => c.id === 'train');
            return hasSize && hasTrain;
        }
    },
    {
        name: "Paper (Research)",
        type: "paper",
        entity: { citations: 50 },
        tags: [],
        check: (insights, cases) => {
            const hasCite = insights.some(i => i.label === 'Citations' && i.value === 50);
            const hasRes = cases.some(c => c.id === 'research');
            return hasCite && hasRes;
        }
    }
];

let passed = 0;
tests.forEach(t => {
    const insights = getQuickInsights(t.entity, t.type);
    const cases = getUseCases(t.tags, '', t.type);

    if (t.check(insights, cases)) {
        console.log(`✅ ${t.name}: PASS`);
        passed++;
    } else {
        console.error(`❌ ${t.name}: FAIL`);
        console.log("Insights:", insights);
        console.log("Cases:", cases);
    }
});

if (passed === tests.length) {
    console.log(`\n🎉 All ${passed} tests passed. Logic is verified.`);
    process.exit(0);
} else {
    console.error(`\n💥 Only ${passed}/${tests.length} tests passed.`);
    process.exit(1);
}
