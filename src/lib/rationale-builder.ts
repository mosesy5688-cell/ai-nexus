/**
 * Template-based FNI-summary generator for the select API.
 * No LLM calls — deterministic, sub-millisecond.
 *
 * Identity contract: this emits a factual evidence/factor summary (FNI facts +
 * specs), NOT a fit-verdict. Free2AITools surfaces the evidence; the calling
 * agent decides. So: no "#N for <task>", no "selected/best/recommended", and no
 * pseudo-confidence — signal strength is already in the FNI fields/badge. The
 * honest caveats (Ollama/GGUF, VRAM, license, recency) are negative-contract
 * content and are retained.
 */

export interface RationaleInput {
  entity: Record<string, any>;
  constraints?: Record<string, any>;
}

export interface RationaleResult {
  fni_summary: string;
  caveats: string[];
}

const FACTOR_LABELS: Record<string, string> = {
  a: 'authority', p: 'popularity', r: 'recency', q: 'quality',
};

export function buildRationale(input: RationaleInput): RationaleResult {
  const { entity: e, constraints } = input;
  const score = e.fni_score ?? 0;
  const caveats: string[] = [];

  const dominant = pickDominant(e);
  const sizeDesc = describeSize(e.params_billions);
  const ctxDesc = e.context_length ? `${Math.round(e.context_length / 1024)}K context` : '';

  // Factual FNI factor/spec summary — projects onto "structured discovery,
  // evidence, and identity layer": it states what the catalog records, never
  // whether the entity fits the caller's task. No verdict, no ranking position.
  let fni_summary = `FNI ${score.toFixed(1)} catalog entry`;
  if (dominant) fni_summary += `; leading factor ${dominant.label} (${dominant.value.toFixed(1)})`;
  if (sizeDesc) fni_summary += `; ${sizeDesc}`;
  if (ctxDesc) fni_summary += `; ${ctxDesc}`;
  fni_summary += '.';

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

  if (constraints?.ollama_compatible && !e.has_ollama) {
    caveats.push('Ollama compatibility based on GGUF availability — verify direct Ollama support before deployment');
  }

  if (constraints?.min_context_length && e.context_length) {
    const ratio = e.context_length / constraints.min_context_length;
    if (ratio < 1.5) caveats.push(`Context length (${e.context_length}) is close to your minimum (${constraints.min_context_length})`);
  }

  return { fni_summary, caveats };
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
