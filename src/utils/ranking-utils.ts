/**
 * Ranking Utilities
 * 
 * B.14 P2: FNI Dimension-based sorting utilities
 * Extracted for CES compliance (250 line limit)
 */

export interface FNIComponents {
    s: number; // Semantic
    a: number; // Authority
    p: number; // Popularity
    r: number; // Recency
    q: number; // Quality
}

export interface RankableModel {
    fni_score?: number;
    fni_components?: FNIComponents;
    downloads?: number;
    likes?: number;
    last_updated?: string;
    [key: string]: any;
}

/**
 * Sort models by FNI dimension
 * @param models Array of models to sort
 * @param dim Dimension to sort by: 'fni' | 's' | 'a' | 'p' | 'r' | 'q'
 */
export function sortByDimension(models: RankableModel[], dim: string): RankableModel[] {
    return [...models].sort((a, b) => {
        const aComp = a.fni_components || { s: 50, a: 0, p: 0, r: 0, q: 0 };
        const bComp = b.fni_components || { s: 50, a: 0, p: 0, r: 0, q: 0 };
        switch (dim) {
            case 's': return bComp.s - aComp.s;
            case 'a': return bComp.a - aComp.a;
            case 'p': return bComp.p - aComp.p;
            case 'r': return bComp.r - aComp.r;
            case 'q': return bComp.q - aComp.q;
            default: return (b.fni_score ?? b.fni ?? 0) - (a.fni_score ?? a.fni ?? 0);
        }
    });
}

/**
 * Sort models by downloads (descending)
 */
export function sortByDownloads(models: RankableModel[]): RankableModel[] {
    return [...models].sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
}

/**
 * Sort models by last updated (newest first)
 */
export function sortByNewest(models: RankableModel[]): RankableModel[] {
    return [...models].sort((a, b) => {
        const dateA = a.last_updated ? new Date(a.last_updated).getTime() : 0;
        const dateB = b.last_updated ? new Date(b.last_updated).getTime() : 0;
        return dateB - dateA;
    });
}
