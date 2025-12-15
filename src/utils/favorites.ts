/**
 * LocalStorage Favorites Manager
 * V4.9 Content Activation - Retention Feature
 * 
 * Constitutional Compliance:
 * - Art.IX-Batch: No KV writes for retention (LocalStorage only)
 * - Art.1-E: Content Completeness - user can save and return
 */

const FAVORITES_KEY = 'f2at_favorites';
const MAX_FAVORITES = 100;

export interface FavoriteItem {
    umid: string;
    name: string;
    entityType: string;
    addedAt: number;
}

/**
 * Get all favorites from LocalStorage
 */
export function getFavorites(): FavoriteItem[] {
    if (typeof localStorage === 'undefined') return [];
    try {
        const data = localStorage.getItem(FAVORITES_KEY);
        return data ? JSON.parse(data) : [];
    } catch {
        return [];
    }
}

/**
 * Add an item to favorites
 */
export function addFavorite(umid: string, name: string, entityType: string = 'model'): void {
    if (typeof localStorage === 'undefined') return;

    const favorites = getFavorites();

    // Check if already exists
    if (favorites.some(f => f.umid === umid)) {
        return;
    }

    // Add new item at the beginning
    favorites.unshift({
        umid,
        name,
        entityType,
        addedAt: Date.now()
    });

    // Limit to max items
    const trimmed = favorites.slice(0, MAX_FAVORITES);

    localStorage.setItem(FAVORITES_KEY, JSON.stringify(trimmed));

    // Dispatch event for UI updates
    window.dispatchEvent(new CustomEvent('favorites-updated', { detail: { action: 'add', umid } }));
}

/**
 * Remove an item from favorites
 */
export function removeFavorite(umid: string): void {
    if (typeof localStorage === 'undefined') return;

    const favorites = getFavorites();
    const filtered = favorites.filter(f => f.umid !== umid);

    localStorage.setItem(FAVORITES_KEY, JSON.stringify(filtered));

    // Dispatch event for UI updates
    window.dispatchEvent(new CustomEvent('favorites-updated', { detail: { action: 'remove', umid } }));
}

/**
 * Check if an item is favorited
 */
export function isFavorite(umid: string): boolean {
    return getFavorites().some(f => f.umid === umid);
}

/**
 * Toggle favorite status
 */
export function toggleFavorite(umid: string, name: string, entityType: string = 'model'): boolean {
    if (isFavorite(umid)) {
        removeFavorite(umid);
        return false;
    } else {
        addFavorite(umid, name, entityType);
        return true;
    }
}

/**
 * Get favorites count
 */
export function getFavoritesCount(): number {
    return getFavorites().length;
}

/**
 * Clear all favorites
 */
export function clearFavorites(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(FAVORITES_KEY);
    window.dispatchEvent(new CustomEvent('favorites-updated', { detail: { action: 'clear' } }));
}
