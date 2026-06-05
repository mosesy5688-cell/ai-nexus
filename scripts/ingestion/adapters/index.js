/**
 * Adapter Registry
 * 
 * Central registry for all data source adapters.
 * V6.2: Added HuggingFace Papers adapter for daily papers.
 * 
 * @module ingestion/adapters
 */

import { HuggingFaceAdapter } from './huggingface-adapter.js';
import { GitHubAdapter } from './github-adapter.js';
import { DatasetsAdapter } from './datasets-adapter.js';
import { ArXivAdapter } from './arxiv-adapter.js';
// PWC adapter removed - API blocked
import { OllamaAdapter } from './ollama-adapter.js';
import { CivitAIAdapter } from './civitai-adapter.js';
// ModelScope adapter removed
import { OpenLLMLeaderboardAdapter } from './openllm-adapter.js';
import { DeepSpecAdapter } from './deepspec-adapter.js';
import { SemanticScholarAdapter } from './semanticscholar-adapter.js';
import { HuggingFacePapersAdapter } from './huggingface-papers-adapter.js';
import { MCPAdapter } from './mcp-adapter.js';  // V6.2: MCP Registry
import { ReplicateAdapter } from './replicate-adapter.js';  // B.1: Replicate
import { KaggleAdapter } from './kaggle-adapter.js';  // B.1: Kaggle
// LangChainAdapter retired — `prompt` (#2141) + `agent` (this PR) both cancelled,
// so it emits nothing. Routing entry removed; file kept on disk for clean revert.
import { SpacesAdapter } from './spaces-adapter.js';  // V12: HF Spaces (space merged into model — adapter now emits nothing)
import { AgentsAdapter } from './agents-adapter.js';  // V12: AI Agents (agent cancelled — now emits type=tool)
import { BenchmarkAdapter } from './benchmark-adapter.js';  // 5th-type: leaderboard sub-benchmark nodes (EVALUATED_ON targets)

// Export base for extension
export { BaseAdapter, NSFW_KEYWORDS, LICENSE_MAP } from './base-adapter.js';

// Export individual adapters
export { HuggingFaceAdapter } from './huggingface-adapter.js';
export { GitHubAdapter } from './github-adapter.js';
export { DatasetsAdapter } from './datasets-adapter.js';
export { ArXivAdapter } from './arxiv-adapter.js';
// export { PapersWithCodeAdapter } from './pwc-adapter.js'; // Removed
export { OllamaAdapter } from './ollama-adapter.js';
export { CivitAIAdapter } from './civitai-adapter.js';
// export { ModelScopeAdapter } from './modelscope-adapter.js'; // Removed
export { OpenLLMLeaderboardAdapter } from './openllm-adapter.js';
export { DeepSpecAdapter } from './deepspec-adapter.js';
export { SemanticScholarAdapter } from './semanticscholar-adapter.js';
export { HuggingFacePapersAdapter } from './huggingface-papers-adapter.js';
export { MCPAdapter } from './mcp-adapter.js';  // V6.2: MCP Registry
export { ReplicateAdapter } from './replicate-adapter.js';  // B.1: Replicate
export { KaggleAdapter } from './kaggle-adapter.js';  // B.1: Kaggle
// LangChainAdapter export retired with its routing entry (emits nothing post-cancel).
export { SpacesAdapter } from './spaces-adapter.js';  // V12: HF Spaces
export { AgentsAdapter } from './agents-adapter.js';  // V12: AI Agents
export { BenchmarkAdapter } from './benchmark-adapter.js';  // 5th-type

// Registered adapters (V4.3.2 - Multi-source with Benchmarks + Specs + Citations)
export const adapters = {
    // Tier 1: Core Sources
    'huggingface': new HuggingFaceAdapter(),
    'huggingface-datasets': new DatasetsAdapter(),
    'github': new GitHubAdapter(),

    // Tier 2: Academic Sources
    'arxiv': new ArXivAdapter(),
    // 'paperswithcode': removed - API blocked

    // V6.2: HuggingFace Papers (alternative to blocked PWC)
    'huggingface-papers': new HuggingFacePapersAdapter(),
    'semanticscholar': new SemanticScholarAdapter(),

    // Tier 3: Ecosystem Sources
    'ollama': new OllamaAdapter(),

    // V4.3.1: CivitAI (L2 NSFW filtering verified - production ready)
    'civitai': new CivitAIAdapter(),

    // V4.3.2: Open LLM Leaderboard (Benchmark data) 
    'openllm': new OpenLLMLeaderboardAdapter(),

    // V4.3.2: Deep Spec Extractor (Model specifications)
    'deepspec': new DeepSpecAdapter(),

    // ModelScope adapter removed

    // V6.2: MCP Registry (AI Agents / MCP Servers)
    'mcp': new MCPAdapter(),

    // B.1: Replicate (15K+ models)
    'replicate': new ReplicateAdapter(),

    // B.1: Kaggle (200K+ datasets/models)
    'kaggle': new KaggleAdapter(),

    // LangChain Hub retired — `prompt` (#2141) + `agent` (this PR) cancelled.
    // After both, normalize() emits nothing, so the routing entry is removed
    // (the harvest workflow LangChain step is dropped too). Revert: re-add here.

    // V12: HuggingFace Spaces (Interactive demos) — `space` merged into `model`.
    // The adapter's normalize() now returns null (emits nothing); registered for
    // a manual harvest path but produces no entities. Workflow step dropped.
    'huggingface-spaces': new SpacesAdapter(),

    // V12: AI Agents (Frameworks & tools from GitHub) — `agent` cancelled, now
    // emits type=tool (every curated/discovered repo survives as a tool).
    'agents': new AgentsAdapter(),

    // 5th-type: Benchmark nodes from a curated seed catalog. Identity-edge
    // generator — promotes the Open LLM Leaderboard v2 sub-benchmarks to
    // first-class nodes so EVALUATED_ON (model->benchmark) targets exist.
    'benchmark': new BenchmarkAdapter(),
};

/**
 * Get adapter by name
 */
export function getAdapter(name) {
    const adapter = adapters[name];
    if (!adapter) {
        throw new Error(`Unknown adapter: ${name}. Available: ${Object.keys(adapters).join(', ')}`)
    }
    return adapter;
}

/**
 * Get all registered adapter names
 */
export function getAdapterNames() {
    return Object.keys(adapters);
}

/**
 * Get adapters by tier
 */
export function getTier1Adapters() {
    return ['huggingface', 'huggingface-datasets', 'github'];
}

export function getTier2Adapters() {
    return ['arxiv'];
}

export function getTier3Adapters() {
    return ['ollama', 'civitai', 'modelscope'];
}

/**
 * V4.3.1: Get all adapters for parallel harvesting
 */
export function getAllAdapters() {
    return Object.keys(adapters);
}

export default adapters;
