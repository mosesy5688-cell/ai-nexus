


export interface Env {
    DB: D1Database;
    R2_ASSETS: R2Bucket;
    UNIFIED_WORKFLOW: Workflow;
    HYDRATION_QUEUE: Queue;
    KV?: KVNamespace; // Art 2.3 Kill-Switch support
}

export interface WorkflowResult {
    status: string;
    ingest?: { filesProcessed: number; modelsIngested: number; messagesQueued?: number };
    fni?: { modelsCalculated: number; mode: string };
    duration_ms: number;
}
