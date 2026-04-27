/**
 * Template-based rationale generator for select_model API.
 * No LLM calls — deterministic, sub-millisecond.
 */

export interface RationaleInput {
  entity: Record<string, any>;
  rank: number;
  taskTag: string;
  constraints?: Record<string, any>;
}

export interface RationaleResult {
  rationale: string;
  caveats: string[];
  confidence: number;
}

const FACTOR_LABELS: Record<string, string> = {
  a: 'authority', p: 'popularity', r: 'recency', q: 'quality',
};

export function buildRationale(input: RationaleInput): RationaleResult {
  const { entity: e, rank, taskTag, constraints } = input;
  const score = e.fni_score ?? 0;
  const caveats: string[] = [];

  const dominant = pickDominant(e);
  const sizeDesc = describeSize(e.params_billions);
  const ctxDesc = e.context_length ? `${Math.round(e.context_length / 1024)}K context` : '';

  let rationale = `#${rank} for ${taskTag}: ${e.name || e.id} (FNI ${score.toFixed(1)})`;
  if (dominant) rationale += ` — strong ${dominant.label} (${dominant.value.toFixed(1)})`;
  if (sizeDesc) rationale += `, ${sizeDesc}`;
  if (ctxDesc) rationale += `, ${ctxDesc}`;
  rationale += '.';

  if (e.vram_estimate_gb && e.vram_estimate_gb > 0) {
    caveats.push(`VRAM estimate (${e.vram_estimate_gb} GB) is approximate — actual depends on quantization and batch size`);
  }

  if (e.last_modified) {
    const days = Math.floor((Date.now() - new Date(e.last_modified).getTime()) / 86400000);
    if (days > 90) caveats.push(`Last updated ${days} days ago — check for newer releases`);
  }

  const license = (e.license || '').toLowerCase();
  if (license && !['apache-2.0', 'mit', 'bsd-3-clause', 'bsd-2-clause', 'cc0-1.0', 'unlicense'].includes(license)) {
    caveats.push(`License (${e.license}) may have restrictions — verify before commercial use`);
  }

  if (constraints?.ollama_compatible) {
    caveats.push('Ollama compatibility inferred from model size — not explicitly verified');
  }

  if (constraints?.min_context_length && e.context_length) {
    const ratio = e.context_length / constraints.min_context_length;
    if (ratio < 1.5) caveats.push(`Context length (${e.context_length}) is close to your minimum (${constraints.min_context_length})`);
  }

  const confidence = computeConfidence(e, constraints);

  return { rationale, caveats, confidence };
}

function pickDominant(e: Record<string, any>) {
  let best = { key: '', value: 0, label: '' };
  for (const [k, label] of Object.entries(FACTOR_LABELS)) {
    const v = e[`fni_${k}`] ?? 0;
    if (v > best.value) best = { key: k, value: v, label };
  }
  return best.value > 0 ? best : null;
}

function describeSize(params?: number) {
  if (!params || params <= 0) return '';
  if (params < 1) return `${Math.round(params * 1000)}M params`;
  if (params < 10) return `${params.toFixed(1)}B params`;
  return `${Math.round(params)}B params`;
}

function computeConfidence(e: Record<string, any>, constraints?: Record<string, any>): number {
  let conf = 0.7;
  if (e.fni_score >= 40) conf += 0.1;
  if (e.downloads > 1000) conf += 0.05;
  if (e.last_modified) {
    const days = (Date.now() - new Date(e.last_modified).getTime()) / 86400000;
    if (days < 30) conf += 0.05;
  }
  if (constraints?.max_vram_gb && e.vram_estimate_gb > 0 && e.vram_estimate_gb <= constraints.max_vram_gb) conf += 0.05;
  return Math.min(0.95, Math.round(conf * 100) / 100);
}
