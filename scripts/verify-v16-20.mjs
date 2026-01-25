/**
 * V16.20 Heuristic Extraction Audit
 */
import { hydrateEntity } from '../src/utils/entity-hydrator.js';

const mockLlama2 = {
    id: 'replicate--meta/llama-2-70b-chat',
    name: 'Llama 2 70b Chat',
    fni_score: 85
};

console.log("=== V16.20 Heuristic Audit ===");
const hydrated = hydrateEntity(mockLlama2, 'model', []);

console.log(`Name: ${hydrated.name}`);
console.log(`Params: ${hydrated.params_billions}B`);
console.log(`VRAM Est: ~${hydrated.vram_gb}GB`);
console.log(`Context: ${hydrated.context_length / 1024}k`);

if (hydrated.params_billions === 70) {
    console.log("[PASS] Correctly extracted 70B from name.");
} else {
    console.log("[FAIL] Failed to extract parameters from name.");
}

console.log("=== Audit Complete ===");
