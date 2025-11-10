export interface Model {
    id: string;
    name: string;
    sourcePlatform: string;
    description: string;
    source: string;
    task: string;
    tags: string[];
    likes: number;
    downloads: number;
}