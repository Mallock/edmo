/**
 * Model-fit estimator — parses parameter counts out of LM Studio model ids
 * and classifies each model against the machine's RAM/VRAM so the player
 * doesn't load something too big for their rig.
 *
 * Pure module (no DOM/Tauri) — unit-tested in tests/modelfit.test.ts.
 *
 * Heuristics (Q4_K_M-class quantization, the LM Studio default):
 *   weights ≈ params_B × 0.6 GB, plus ~1.5 GB for KV-cache/runtime overhead.
 *   GPU budget = VRAM − 1 GB driver/display reserve − 6 GB for ED's renderer
 *   while the game runs (this is a game companion — fit is judged for play).
 *   CPU budget = RAM − 6 GB OS/apps − 6 GB for ED while it runs.
 */

export interface GpuInfo {
  name: string;
  vramMb: number;
}

export interface SystemSpecs {
  totalRamMb: number;
  cpuCores: number;
  cpuName: string;
  gpus: GpuInfo[];
}

export interface ModelParams {
  /** Total parameter count in billions (memory-determining), null if unknown. */
  totalB: number | null;
  /** Active parameters for MoE models ("-a3b"), null if dense/unknown. */
  activeB: number | null;
}

export type ModelFit = 'gpu' | 'cpu' | 'big' | 'unknown';

export interface ModelVerdict {
  fit: ModelFit;
  needGb: number | null;
  params: ModelParams;
}

const GB = 1024;

/** "qwen3.6-35b-a3b" → {totalB:35, activeB:3}; "8x7b" → 56; "270m" → 0.27. */
export function parseModelParams(id: string): ModelParams {
  const s = id.toLowerCase();
  const candidates: number[] = [];

  // Mixtral-style NxMb mixtures — memory is bound by all experts.
  const moe = /(\d+)x(\d+(?:\.\d+)?)b(?![a-z0-9])/.exec(s);
  if (moe) candidates.push(Number(moe[1]) * Number(moe[2]));

  // MoE active-params marker: "-a3b".
  const act = /(?:^|[^a-z0-9])a(\d+(?:\.\d+)?)b(?![a-z0-9])/.exec(s);
  const activeB = act ? Number(act[1]) : null;

  // Dense sizes: "27b", "1.5b" — also Gemma's effective "e2b"/"e4b".
  // Preceding char must not be alphanumeric (rejects the "3b" inside "a3b"),
  // except a literal 'e'.
  for (const m of s.matchAll(/(?:^|[^a-z0-9]|e)(\d+(?:\.\d+)?)b(?![a-z0-9])/g)) {
    candidates.push(Number(m[1]));
  }

  // Million-scale models: "270m".
  for (const m of s.matchAll(/(?:^|[^a-z0-9])(\d+)m(?![a-z0-9])/g)) {
    candidates.push(Number(m[1]) / 1000);
  }

  const totals = candidates.filter((n) => Number.isFinite(n) && n > 0);
  let totalB = totals.length ? Math.max(...totals) : null;
  if (totalB === null && activeB !== null) totalB = activeB;
  return { totalB, activeB };
}

export function isEmbeddingModel(id: string): boolean {
  return /embed/i.test(id);
}

/** Estimated memory footprint at Q4-class quantization, in GB. */
export function estimateNeedGb(totalB: number): number {
  return totalB * 0.6 + 1.5;
}

/** VRAM Elite Dangerous itself needs while running (1440p/high ballpark). */
const ED_VRAM_GB = 6;
/** RAM the game needs on top of the ~6 GB OS/background reserve. */
const ED_RAM_GB = 6;
const OS_RAM_GB = 6;

export function gpuBudgetGb(specs: SystemSpecs, gameRunning = true): number {
  const vram = Math.max(0, ...specs.gpus.map((g) => g.vramMb)) / GB;
  return Math.max(0, vram - 1 - (gameRunning ? ED_VRAM_GB : 0));
}

export function cpuBudgetGb(specs: SystemSpecs, gameRunning = true): number {
  return Math.max(0, specs.totalRamMb / GB - OS_RAM_GB - (gameRunning ? ED_RAM_GB : 0));
}

/** Largest parameter count (B) that fits a budget, floored to whole billions. */
function maxParamsForBudget(budgetGb: number): number {
  return Math.max(0, Math.floor((budgetGb - 1.5) / 0.6));
}

/**
 * Classify a model against the machine. `gameRunning` defaults to true — the
 * HUD exists to run next to ED, so fit is judged with the game's own VRAM/RAM
 * appetite reserved.
 */
export function classifyModel(
  id: string,
  specs: SystemSpecs | null,
  gameRunning = true,
): ModelVerdict {
  const params = parseModelParams(id);
  if (!specs || specs.totalRamMb === 0 || params.totalB === null) {
    return { fit: 'unknown', needGb: params.totalB ? estimateNeedGb(params.totalB) : null, params };
  }
  const needGb = estimateNeedGb(params.totalB);
  if (needGb <= gpuBudgetGb(specs, gameRunning)) return { fit: 'gpu', needGb, params };
  if (needGb <= cpuBudgetGb(specs, gameRunning)) return { fit: 'cpu', needGb, params };
  return { fit: 'big', needGb, params };
}

/** Short per-model annotation for the selector dropdown. */
export function fitLabel(v: ModelVerdict): string {
  const size = v.needGb !== null ? `~${v.needGb.toFixed(1)} GB` : '';
  switch (v.fit) {
    case 'gpu':
      return `✓ ${size} fits GPU`;
    case 'cpu':
      return `◐ ${size} CPU only (slow)`;
    case 'big':
      return `⚠ ${size} TOO BIG`;
    default:
      return '';
  }
}

/** One-line human summary of the machine. */
export function specsLabel(specs: SystemSpecs): string {
  const bits: string[] = [];
  if (specs.cpuName) bits.push(`${specs.cpuName} (${specs.cpuCores} threads)`);
  bits.push(`${Math.round(specs.totalRamMb / GB)} GB RAM`);
  const gpu = specs.gpus[0];
  if (gpu) bits.push(`${gpu.name} ${Math.round(gpu.vramMb / GB)} GB`);
  else bits.push('no dedicated GPU detected');
  return bits.join(' · ');
}

/**
 * Concrete sizing advice. Leads with the while-flying number (ED's own
 * VRAM/RAM appetite reserved) and mentions the game-closed ceiling.
 */
export function recommendationLabel(specs: SystemSpecs): string {
  const gpuPlay = maxParamsForBudget(gpuBudgetGb(specs, true));
  const gpuIdle = maxParamsForBudget(gpuBudgetGb(specs, false));
  const cpuPlay = maxParamsForBudget(cpuBudgetGb(specs, true));
  if (gpuPlay >= 1) {
    return (
      `Recommended while flying: up to ~${gpuPlay}B parameters (Q4) on GPU — the game itself ` +
      `needs ~${6} GB VRAM. With ED closed: up to ~${gpuIdle}B. Bigger models spill to CPU/RAM ` +
      `(≤~${cpuPlay}B) but answer slowly and steal cores from the game.`
    );
  }
  if (gpuIdle >= 1) {
    return (
      `Your GPU only fits a model when ED is NOT running (up to ~${gpuIdle}B Q4). While flying, ` +
      `use a small CPU model (≤~${cpuPlay}B) — or lower the game's graphics settings to free VRAM.`
    );
  }
  if (cpuPlay >= 1) {
    return (
      `No dedicated GPU headroom — CPU/RAM fits ~${cpuPlay}B (Q4), but inference competes with ` +
      `the game for cores. Prefer the smallest model that answers well.`
    );
  }
  return 'Very limited memory — stick to sub-1B models.';
}
