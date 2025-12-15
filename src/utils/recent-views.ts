/**
 * Recent Views Manager
 * V4.9 Content Activation - Resume Feature
 * 
 * Tracks recently viewed entities for "Continue where you left off"
 * 
 * Constitutional Compliance:
 * - Art.IX-Batch: No KV writes for retention (LocalStorage only)
 */

const RECENT_KEY = 'f2at_recent';
const MAX_RECENT = 5;

export interface RecentItem {
    umid: string;
    name: string;
    entityType: string;
    viewedAt: number;
}

/**
 * Get recent views from LocalStorage
 */
export function getRecentViews(): RecentItem[] {
    if (typeof localStorage === 'undefined') return [];
    try {
        const data = localStorage.getItem(RECENT_KEY);
        return data ? JSON.parse(data) : [];
    } catch {
        return [];
    }
}

/**
 * Add a view to recent history
 */
export function addRecentView(umid: string, name: string, entityType: string = 'model'): void {
    if (typeof localStorage === 'undefined') return;

    const recent = getRecentViews();

    // Remove if already exists (we'll add it at the top)
    const filtered = recent.filter(r => r.umid !== umid);

    // Add new item at the beginning
    filtered.unshift({
        umid,
        name,
        entityType,
        viewedAt: Date.now()
    });

    // Limit to max items
    const trimmed = filtered.slice(0, MAX_RECENT);

    localStorage.setItem(RECENT_KEY, JSON.stringify(trimmed));
}

/**
 * Get most recent item
 */
export function getMostRecent(): RecentItem | null {
    const recent = getRecentViews();
    return recent.length > 0 ? recent[0] : null;
}

/**
 * Clear recent views
 */
export function clearRecentViews(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(RECENT_KEY);
}

/**
 * Check if there are any recent views
 */
export function hasRecentViews(): boolean {
    return getRecentViews().length > 0;
}
