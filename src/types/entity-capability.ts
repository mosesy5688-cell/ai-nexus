/**
 * Entity Capabilities
 * V4.9 Entity-First Architecture
 * 
 * Art.X-Capability-Gating: UI modules enabled by capability only
 * Art.X-Capability-Naming: Capabilities MUST be nouns only
 *   ❌ FORBIDDEN: has_fni, fni_v2
 *   ✅ ALLOWED: fni, deploy, benchmark
 */

/**
 * Entity capabilities - nouns only per Art.X-Capability-Naming
 * These determine which UI modules are enabled for each entity
 */
export type EntityCapability =
    | 'fni'           // FNI scoring (Model only)
    | 'deploy'        // Deployability info
    | 'benchmark'     // Benchmark results
    | 'architecture'  // Neural architecture visualization
    | 'citations'     // Academic citations
    | 'size'          // Data size metrics
    | 'pricing'       // Commercial pricing
    | 'integrations'  // Tool/API integrations
    | 'ollama'        // Ollama availability
    | 'gguf';         // GGUF variants

/**
 * Capability to module mapping
 * Used by EntityShell for capability-gated rendering
 */
export const CAPABILITY_MODULES: Record<EntityCapability, string> = {
    fni: 'FNIModule',
    deploy: 'DeployModule',
    benchmark: 'BenchmarkModule',
    architecture: 'ArchitectureModule',
    citations: 'CitationsModule',
    size: 'SizeModule',
    pricing: 'PricingModule',
    integrations: 'IntegrationsModule',
    ollama: 'OllamaModule',
    gguf: 'GGUFModule',
};

/**
 * Check if an entity has a specific capability
 */
export function hasCapability(
    capabilities: EntityCapability[],
    capability: EntityCapability
): boolean {
    return capabilities.includes(capability);
}

/**
 * Get enabled modules for an entity based on its capabilities
 */
export function getEnabledModules(capabilities: EntityCapability[]): string[] {
    return capabilities
        .filter((cap) => cap in CAPABILITY_MODULES)
        .map((cap) => CAPABILITY_MODULES[cap]);
}
