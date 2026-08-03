/** Model-fit estimator — id parsing + machine classification. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyModel,
  cpuBudgetGb,
  estimateNeedGb,
  gpuBudgetGb,
  isEmbeddingModel,
  parseModelParams,
  recommendationLabel,
  type SystemSpecs,
  gpuLayerBudget,
  shouldKeepVisionOnCpu,
} from '../src/ui/modelfit.ts';

test('parses dense model sizes from real LM Studio ids', () => {
  assert.equal(parseModelParams('qwen/qwen3.6-27b').totalB, 27);
  assert.equal(parseModelParams('meta-llama-3.1-8b-instruct').totalB, 8);
  assert.equal(parseModelParams('phi-4-mini-3.8b').totalB, 3.8);
});

test('MoE "-aNb" ids: total params bound memory, active parsed separately', () => {
  const p = parseModelParams('qwen/qwen3.6-35b-a3b');
  assert.equal(p.totalB, 35);
  assert.equal(p.activeB, 3);
});

test('gemma effective sizes and NxMb mixtures', () => {
  assert.equal(parseModelParams('google/gemma-4-e2b').totalB, 2);
  assert.equal(parseModelParams('mixtral-8x7b-instruct').totalB, 56);
  assert.equal(parseModelParams('gemma-270m').totalB, 0.27);
});

test('unknown ids and embedding models', () => {
  assert.equal(parseModelParams('my-custom-model').totalB, null);
  assert.ok(isEmbeddingModel('text-embedding-nomic-embed-text-v1.5'));
  assert.ok(!isEmbeddingModel('qwen/qwen3.6-27b'));
});

const RIG_32GB_12GBVRAM: SystemSpecs = {
  totalRamMb: 32 * 1024,
  cpuCores: 16,
  cpuName: 'Test CPU',
  gpus: [{ name: 'Test GPU', vramMb: 12 * 1024 }],
};

const RIG_16GB_NOGPU: SystemSpecs = {
  totalRamMb: 16 * 1024,
  cpuCores: 8,
  cpuName: 'Test CPU',
  gpus: [],
};

test('classification reserves memory for the running game by default', () => {
  // 8B → ~6.3 GB. While flying the 12 GB GPU only has 5 GB free (−1 driver,
  // −6 for ED's renderer) → spills to CPU; with the game closed it fits GPU.
  assert.equal(classifyModel('llama-3.1-8b', RIG_32GB_12GBVRAM).fit, 'cpu');
  assert.equal(classifyModel('llama-3.1-8b', RIG_32GB_12GBVRAM, false).fit, 'gpu');
  // 27B → ~17.7 GB → CPU-only either way on this rig.
  assert.equal(classifyModel('qwen/qwen3.6-27b', RIG_32GB_12GBVRAM).fit, 'cpu');
  // 70B → ~43.5 GB → too big outright.
  assert.equal(classifyModel('llama-3.3-70b', RIG_32GB_12GBVRAM).fit, 'big');
  assert.equal(classifyModel('mystery-model', RIG_32GB_12GBVRAM).fit, 'unknown');
});

test('no-GPU rig classifies against RAM, tighter while the game runs', () => {
  assert.equal(gpuBudgetGb(RIG_16GB_NOGPU), 0);
  // 16 GB RAM − 6 OS − 6 game = 4 GB → an 8B (~6.3 GB) is too big in flight…
  assert.equal(classifyModel('llama-3.1-8b', RIG_16GB_NOGPU).fit, 'big');
  // …but fits RAM with the game closed (16 − 6 = 10 GB).
  assert.equal(classifyModel('llama-3.1-8b', RIG_16GB_NOGPU, false).fit, 'cpu');
  assert.equal(classifyModel('qwen/qwen3.6-27b', RIG_16GB_NOGPU, false).fit, 'big');
});

test('budgets and recommendation text are sane', () => {
  assert.equal(gpuBudgetGb(RIG_32GB_12GBVRAM), 5); // 12 − 1 − 6 (game)
  assert.equal(gpuBudgetGb(RIG_32GB_12GBVRAM, false), 11);
  assert.equal(cpuBudgetGb(RIG_32GB_12GBVRAM), 20); // 32 − 6 − 6
  assert.equal(cpuBudgetGb(RIG_32GB_12GBVRAM, false), 26);
  assert.ok(estimateNeedGb(7) > 5 && estimateNeedGb(7) < 7);
  const rec = recommendationLabel(RIG_32GB_12GBVRAM);
  assert.match(rec, /while flying: up to ~5B/); // floor((5−1.5)/0.6) = 5
  assert.match(rec, /ED closed: up to ~15B/); // floor((11−1.5)/0.6) = 15
  assert.match(recommendationLabel(RIG_16GB_NOGPU), /CPU/);
});

// --- leaving room for the game ------------------------------------------------
// engine_start always accepted a layer count and was never given one: the
// bridge sent only a context size, so every model loaded with -ngl 99 while the
// settings panel's own advisor warned about the very fit it was ignoring.
// Figures below are measured on an RX 7800 XT, llama.cpp b10107, Vulkan.

const rig = (vramGb: number, ramGb = 32): SystemSpecs => ({
  totalRamMb: ramGb * 1024,
  cpuCores: 8,
  cpuName: 'test',
  gpus: [{ name: 'test gpu', vramMb: vramGb * 1024 }],
});

test('a model that fits beside the game keeps every layer on the card', () => {
  // 16 GB card: 16 - 1 driver - 6 for ED = 9 GB budget; gemma-4-e4b is ~5.9 GB.
  assert.equal(gpuLayerBudget(rig(16), 5.9, 40), 99);
  // ...and the same model on a 24 GB card, obviously.
  assert.equal(gpuLayerBudget(rig(24), 5.9, 40), 99);
});

test('a model that does NOT fit steps down instead of starving the renderer', () => {
  // 8 GB card: 8 - 1 - 6 = 1 GB budget. A 5.9 GB model cannot have the card.
  const layers = gpuLayerBudget(rig(8), 5.9, 40);
  assert.ok(layers < 40 && layers >= 0, `expected a partial offload, got ${layers}`);
  // 12 GB card: 12 - 1 - 6 = 5 GB. Most of a 5.9 GB model, but not all of it.
  const mid = gpuLayerBudget(rig(12), 5.9, 40);
  assert.ok(mid > 0 && mid < 40, `expected partial, got ${mid}`);
  // More headroom must never mean fewer layers.
  assert.ok(mid >= layers);
});

test('with the game closed the whole card is available', () => {
  // Same 8 GB rig, game not running: 8 - 1 = 7 GB, so a 5.9 GB model fits.
  assert.equal(gpuLayerBudget(rig(8), 5.9, 40, false), 99);
});

test('the layer budget degrades safely rather than guessing', () => {
  assert.equal(gpuLayerBudget(null, 5.9, 40), 99); // specs unknown → ship's default
  assert.equal(gpuLayerBudget(rig(16), 0, 40), 99); // size unknown → default
  assert.equal(gpuLayerBudget(rig(16), Number.NaN, 40), 99);
  assert.equal(gpuLayerBudget(rig(16), 5.9, 0), 99); // layer count unknown
  assert.equal(gpuLayerBudget(rig(4), 5.9, 40), 0); // 4 - 1 - 6 < 0 → CPU only
});

test('vision stays on the CPU unless the card is roomy', () => {
  // Measured: 921 MB back on gemma, 2,172 MB on a 9B, no text-latency cost.
  assert.equal(shouldKeepVisionOnCpu(rig(8)), true);
  assert.equal(shouldKeepVisionOnCpu(rig(16)), true); // 9 GB budget — still worth it
  assert.equal(shouldKeepVisionOnCpu(rig(24)), false); // 17 GB — no need to slow glances
  assert.equal(shouldKeepVisionOnCpu(null), true); // unknown rig → be polite to the game
  // Game closed on a big card: plenty of room, keep glances fast.
  assert.equal(shouldKeepVisionOnCpu(rig(16), false), false);
});
