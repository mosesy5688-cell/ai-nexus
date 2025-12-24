/**
 * Entity Integrity Check - Frontend Utility
 * 
 * V1.1-LOCK: Provides entity-level integrity verification for frontend
 * Uses entity hash (not ETag) for degradation marking
 * 
 * @module utils/entity-integrity
 */

/**
 * Check entity integrity using entity-level hash
 * @param {Object} entity - The entity to check
 * @param {string|null} expectedHash - Expected hash (from manifest or source)
 * @returns {'verified'|'degraded'|'unknown'}
 */
export function checkEntityIntegrity(entity, expectedHash) {
    if (!expectedHash) {
        return 'unknown';
    }

    // Use entity's own hash fields (not ETag - per V1.1-LOCK spec)
    const actualHash = entity.readme_hash || entity.content_hash || entity.body_hash;

    if (!actualHash) {
        console.warn(`[Integrity] Entity ${entity.id} has no hash field`);
        return 'unknown';
    }

    if (actualHash === expectedHash) {
        return 'verified';
    }

    console.warn(`[Integrity] Entity ${entity.id} hash mismatch: expected ${expectedHash.slice(0, 8)}..., got ${actualHash.slice(0, 8)}...`);
    return 'degraded';
}

/**
 * Mark entity as degraded in cache
 * @param {string} entityId 
 */
export function markEntityAsDegraded(entityId) {
    // Log for monitoring systems
    console.warn(`[Degradation] Entity marked as degraded: ${entityId}`);

    // Could implement:
    // 1. Add to degraded entities list in localStorage
    // 2. Send to analytics/monitoring
    // 3. Display visual indicator in UI

    if (typeof window !== 'undefined' && window.localStorage) {
        try {
            const degraded = JSON.parse(localStorage.getItem('degraded_entities') || '[]');
            if (!degraded.includes(entityId)) {
                degraded.push(entityId);
                // Keep only last 100
                if (degraded.length > 100) degraded.shift();
                localStorage.setItem('degraded_entities', JSON.stringify(degraded));
            }
        } catch (e) {
            // Silent fail for SSR
        }
    }
}

/**
 * Get list of degraded entities
 * @returns {string[]}
 */
export function getDegradedEntities() {
    if (typeof window !== 'undefined' && window.localStorage) {
        try {
            return JSON.parse(localStorage.getItem('degraded_entities') || '[]');
        } catch (e) {
            return [];
        }
    }
    return [];
}

/**
 * Check if entity is degraded
 * @param {string} entityId 
 * @returns {boolean}
 */
export function isEntityDegraded(entityId) {
    return getDegradedEntities().includes(entityId);
}

/**
 * Fetch entity with integrity check
 * @param {string} url 
 * @param {string|null} expectedHash 
 * @returns {Promise<{data: Object, integrity: string}>}
 */
export async function fetchWithIntegrityCheck(url, expectedHash = null) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Fetch failed: ${response.status}`);
    }

    const data = await response.json();
    const integrity = checkEntityIntegrity(data, expectedHash);

    if (integrity === 'degraded') {
        markEntityAsDegraded(data.id || url);
    }

    return { data, integrity };
}
