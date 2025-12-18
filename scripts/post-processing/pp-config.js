import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CONFIG = {
    // Adjusted paths for scripts/post-processing/ location
    CATEGORIES_PATH: path.join(__dirname, '../../src/data/categories.json'),
    KEYWORDS_OUTPUT_PATH: path.join(__dirname, '../../public/data/keywords.json'),
    SEARCH_INDEX_PATH: path.join(__dirname, '../../public/data/search-index.json'),
    RANKINGS_PATH: path.join(__dirname, '../../public/data/rankings.json'),
    PUBLIC_DATA_DIR: path.join(__dirname, '../../public/data'),
    KEYWORD_MERGE_MAP: {
        'gpt-4': 'gpt', 'chatgpt': 'gpt', 'chat': 'general-dialogue-qa', 'chatbot': 'general-dialogue-qa',
        'conversational': 'general-dialogue-qa', 'summarization': 'summarization-extraction',
        'translation': 'translation-localization', 'code': 'code-generation-assistance', 'coding': 'code-generation-assistance',
        'llms': 'llm', 'agent': 'agents', 'ai-agents': 'agents', 'large-language-model': 'large-language-models',
        'prompts': 'prompt', 'tools': 'tool', 'image-generation': 'image-generation', 'text-to-image': 'image-generation',
        'video-generation': 'video-generation-editing', 'text-to-video': 'video-generation-editing',
        'rag': 'rag-knowledge-base-qa', 'retrieval-augmented-generation': 'rag-knowledge-base-qa',
        'data-analysis': 'data-analysis-insights', 'analytics': 'data-analysis-insights',
        'visualization': 'data-analysis-insights', 'statistics': 'data-analysis-insights',
        'sql': 'data-analysis-insights', 'pandas': 'data-analysis-insights'
    }
};

// Ensure output directory exists
if (!fs.existsSync(CONFIG.PUBLIC_DATA_DIR)) {
    fs.mkdirSync(CONFIG.PUBLIC_DATA_DIR, { recursive: true });
}
