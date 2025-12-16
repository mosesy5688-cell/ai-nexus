
import { D1Database, R2Bucket, Workflow, Queue } from 'cloudflare:workers';

export interface Env {
    DB: D1Database;
    R2_ASSETS: R2Bucket;
    UNIFIED_WORKFLOW: Workflow;
    HYDRATION_QUEUE: Queue;
    // Add KV if needed, though mostly used via DB or R2 in this worker
    // KV: KVNamespace; 
}

export interface WorkflowResult {
    status: string;
    ingest?: { filesProcessed: number; modelsIngested: number };
    fni?: { modelsCalculated: number; mode: string };
    duration_ms: number;
}
