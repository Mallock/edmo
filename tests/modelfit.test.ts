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
