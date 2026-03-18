/**
 * V3.1 Phase 5: Filter Configuration Data
 * Extracted from AdvancedFilters.astro to comply with 250 line limit
 */

// Parameter size ranges
export const paramRanges = [
    { id: 'tiny', label: '<1B', min: 0, max: 1 },
    { id: 'small', label: '1-7B', min: 1, max: 7 },
    { id: 'medium', label: '7-13B', min: 7, max: 13 },
    { id: 'large', label: '13-70B', min: 13, max: 70 },
    { id: 'huge', label: '70B+', min: 70, max: Infinity },
];

// Quantization types
export const quantTypes = [
    { id: 'gguf', label: 'GGUF', icon: '📦' },
    { id: 'awq', label: 'AWQ', icon: '⚡' },
    { id: 'gptq', label: 'GPTQ', icon: '🔧' },
    { id: 'fp16', label: 'FP16', icon: '🎯' },
];

// Common licenses
export const licenses = [
    { id: 'apache-2.0', label: 'Apache 2.0' },
    { id: 'mit', label: 'MIT' },
    { id: 'llama2', label: 'Llama 2' },
    { id: 'cc-by-4.0', label: 'CC BY 4.0' },
    { id: 'openrail', label: 'OpenRAIL' },
];

// V3.1 Phase 5: Architecture families
export const architectures = [
    { id: 'llama', label: 'Llama', icon: '🦙' },
    { id: 'mistral', label: 'Mistral', icon: '🌬️' },
    { id: 'qwen', label: 'Qwen', icon: '🔮' },
    { id: 'gpt', label: 'GPT', icon: '🤖' },
    { id: 'gemma', label: 'Gemma', icon: '💎' },
    { id: 'phi', label: 'Phi', icon: 'φ' },
    { id: 'deepseek', label: 'DeepSeek', icon: '🔍' },
];

// V3.1 Phase 5: VRAM Requirements (per UX-PLAN-V3.1)
export const vramRanges = [
    { id: 'low', label: '< 8GB', icon: '💚', maxVram: 8 },
    { id: 'mid', label: '8-16GB', icon: '💛', minVram: 8, maxVram: 16 },
    { id: 'high', label: '24GB+', icon: '🔴', minVram: 24 },
];

// V3.1 Phase 5: Task Types (per UX-PLAN-V3.1)
export const taskTypes = [
    { id: 'chat', label: 'Chat', icon: '💬' },
    { id: 'code', label: 'Code', icon: '💻' },
    { id: 'vision', label: 'Vision', icon: '👁️' },
];
