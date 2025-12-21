/**
 * Ranking Utilities
 * 
 * B.14 P2: FNI Dimension-based sorting utilities
 * Extracted for CES compliance (250 line limit)
 */

export interface FNIComponents {
    p: number;
    v: number;
    c: number;
    u: number;
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
 * @param dim Dimension to sort by: 'fni' | 'p' | 'v' | 'c' | 'u'
 */
export function sortByDimension(models: RankableModel[], dim: string): RankableModel[] {
    return [...models].sort((a, b) => {
        const aComp = a.fni_components || { p: 0, v: 0, c: 0, u: 0 };
        const bComp = b.fni_components || { p: 0, v: 0, c: 0, u: 0 };
        switch (dim) {
            case 'p': return bComp.p - aComp.p;
            case 'v': return bComp.v - aComp.v;
            case 'c': return bComp.c - aComp.c;
            case 'u': return bComp.u - aComp.u;
            default: return (b.fni_score || 0) - (a.fni_score || 0);
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
