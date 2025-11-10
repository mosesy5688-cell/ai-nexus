export interface SourceInfo {
    platform: string;
    url: string;
}

export interface Model {
    id: string;
    name: string;
    author?: string;
    description: string;
    task: string;
    tags: string[];
    likes: number;
    downloads: number;
    lastModified: string;
    readme?: string;
    // A model can have multiple sources (e.g., from Hugging Face and GitHub)
    sources: SourceInfo[];
}