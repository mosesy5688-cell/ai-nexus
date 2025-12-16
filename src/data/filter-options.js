
// src/data/filter-options.js

export const families = [
    { value: 'llama', label: 'Llama' },
    { value: 'mistral', label: 'Mistral' },
    { value: 'gemma', label: 'Gemma' },
    { value: 'qwen', label: 'Qwen' },
    { value: 'phi', label: 'Phi' },
    { value: 'falcon', label: 'Falcon' },
    { value: 'bert', label: 'BERT' },
    { value: 'gpt', label: 'GPT-Neo/J' }
];

export const sortOptions = [
    { value: 'fni', label: 'FNI Score (Best)' },
    { value: 'downloads', label: 'Most Downloads' },
    { value: 'likes', label: 'Most Likes' },
    { value: 'newest', label: 'Newest' },
    { value: 'size_asc', label: 'Smallest Size' },
    { value: 'deploy', label: 'Easiest Deploy' }
];

// Note: These might be used in a range selector logic if not just min/max slider
export const sizeOptions = [
    { value: '', label: 'Any Size' },
    { value: '0-1', label: 'Tiny (<1B)' },
    { value: '1-7', label: 'Small (1-7B)' },
    { value: '7-14', label: 'Medium (7-14B)' },
    { value: '14-40', label: 'Large (14-40B)' },
    { value: '40-100', label: 'XL (40-100B)' },
    { value: '100-999', label: 'XXL (100B+)' }
];

export const contextOptions = [
    { value: '', label: 'Any Context' },
    { value: '0-4096', label: '≤ 4K' },
    { value: '4096-8192', label: '4K-8K' },
    { value: '8192-32768', label: '8K-32K' },
    { value: '32768-131072', label: '32K-128K' },
    { value: '131072-999999', label: '128K+' }
];
