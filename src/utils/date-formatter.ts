export function formatRelativeTime(dateStr?: string): string | null {
    if (!dateStr) return null;
    try {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return null;
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        if (diffMs < 0) return null; // future date
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        if (diffDays === 0) return 'Updated today';
        if (diffDays === 1) return 'Updated yesterday';
        if (diffDays < 30) return `Updated ${diffDays} days ago`;
        const diffMonths = Math.floor(diffDays / 30);
        if (diffMonths < 12) return `Updated ${diffMonths} month${diffMonths > 1 ? 's' : ''} ago`;
        const diffYears = Math.floor(diffMonths / 12);
        return `Updated ${diffYears} year${diffYears > 1 ? 's' : ''} ago`;
    } catch {
        return null;
    }
}
