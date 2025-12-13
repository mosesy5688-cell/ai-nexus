/**
 * V4.7 LocalStorage Retention Utilities
 * Art.1: Content > Aesthetics (no server state)
 * 
 * Features:
 * - Favorites (collect models for later)
 * - Compare list (side-by-side comparison)
 * - Recent views (browsing history)
 */

const STORAGE_KEYS = {
    FAVORITES: 'f2at_favorites',
    COMPARE: 'f2at_compare',
    RECENT: 'f2at_recent'
};

const MAX_RECENT = 20;
const MAX_COMPARE = 4;

// ===== FAVORITES =====

export function getFavorites() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEYS.FAVORITES) || '[]');
    } catch {
        return [];
    }
}

export function addFavorite(model) {
    const favorites = getFavorites();
    if (!favorites.find(f => f.id === model.id)) {
        favorites.unshift({
            id: model.id,
            slug: model.slug,
            name: model.name,
            author: model.author,
            addedAt: new Date().toISOString()
        });
        localStorage.setItem(STORAGE_KEYS.FAVORITES, JSON.stringify(favorites));
    }
    return favorites;
}

export function removeFavorite(modelId) {
    const favorites = getFavorites().filter(f => f.id !== modelId);
    localStorage.setItem(STORAGE_KEYS.FAVORITES, JSON.stringify(favorites));
    return favorites;
}

export function isFavorite(modelId) {
    return getFavorites().some(f => f.id === modelId);
}

// ===== COMPARE LIST =====

export function getCompareList() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEYS.COMPARE) || '[]');
    } catch {
        return [];
    }
}

export function addToCompare(model) {
    let list = getCompareList();
    if (list.length >= MAX_COMPARE) {
        list = list.slice(0, MAX_COMPARE - 1);
    }
    if (!list.find(m => m.id === model.id)) {
        list.push({
            id: model.id,
            slug: model.slug,
            name: model.name
        });
        localStorage.setItem(STORAGE_KEYS.COMPARE, JSON.stringify(list));
    }
    return list;
}

export function removeFromCompare(modelId) {
    const list = getCompareList().filter(m => m.id !== modelId);
    localStorage.setItem(STORAGE_KEYS.COMPARE, JSON.stringify(list));
    return list;
}

export function clearCompare() {
    localStorage.setItem(STORAGE_KEYS.COMPARE, '[]');
    return [];
}

// ===== RECENT VIEWS =====

export function getRecentViews() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEYS.RECENT) || '[]');
    } catch {
        return [];
    }
}

export function addRecentView(model) {
    let recent = getRecentViews().filter(r => r.id !== model.id);
    recent.unshift({
        id: model.id,
        slug: model.slug,
        name: model.name,
        viewedAt: new Date().toISOString()
    });
    if (recent.length > MAX_RECENT) {
        recent = recent.slice(0, MAX_RECENT);
    }
    localStorage.setItem(STORAGE_KEYS.RECENT, JSON.stringify(recent));
    return recent;
}

export function clearRecentViews() {
    localStorage.setItem(STORAGE_KEYS.RECENT, '[]');
    return [];
}
