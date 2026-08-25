/**
 * What do the engine's launch flags actually cost?
 *
 * This app is not the only thing on the card — it runs alongside Elite
 * Dangerous, and every megabyte the KV cache takes is a megabyte the game does
 * not get. So the question is never "how fast can this model go" in isolation;
 * it is what each flag costs in VRAM and buys in latency for the two shapes of
 * work the app actually does:
 *
 *   COMMS   ~700-token prompt, ~20-token answer. Latency-critical: a scene that
 *           misses its moment is thrown away, and the writer runs one at a time.
 *   COPILOT ~2,900-token system prompt, ~150-token answer. Prefill-dominated,
 *           and the reason prompt-processing speed matters at all.
 *
 * Each config is a cold server start, so the numbers include what the flag does
 * to load time and to resident VRAM, not just to tokens per second.
 *
 *   npx tsx scripts/bench-engine.ts [--model gemma-4-e4b] [--reps 3]
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const ENGINE = join(homedir(), 'AppData', 'Roaming', 'ai.laiton.edmissionoperator', 'engine');
// --runtime lets a downloaded build be benchmarked against the pinned one
// without touching the user's install.
const EXE = arg('runtime', join(ENGINE, 'runtime', 'llama-server.exe'));
const MODEL_ID = arg('model', 'gemma-4-e4b');
const MODEL = join(ENGINE, 'models', `${MODEL_ID}.gguf`);
const MMPROJ = join(ENGINE, 'models', `${MODEL_ID}.mmproj.gguf`);
const PORT = Number(arg('port', '52100'));
const KEY = 'bench';
const REPS = Number(arg('reps', '3'));
/** Path to a Gemma-4 assistant drafter, to measure multi-token prediction. */
const DRAFTER = arg('drafter', '');

interface Config {
  name: string;
  note: string;
  args: string[];
}

/** What the app ships today, then one lever at a time. */
const BASE = ['--ctx-size', '32768', '--parallel', '1', '-ngl', '99', '--no-mmproj-offload'];

/**
 * Where the work runs.
 *
 * `-ngl 0` keeps every layer on the CPU. This is not the obviously-losing
 * option it sounds like: the Vulkan path on RDNA3 measured only 8 tok/s for
 * this model, and a memory-bandwidth-bound 4B on DDR5-6000 with a large L3 is
 * in the same league — while leaving the GPU entirely to the game, which is the
 * actual complaint. Thread counts are swept because llama.cpp usually peaks at
 * PHYSICAL cores rather than threads, and because a HUD sharing a machine with
 * Elite wants to leave some cores alone.
 */
const CPU = ['--ctx-size', '32768', '--parallel', '1', '-ngl', '0', '--no-mmproj-offload'];

const CONFIGS: Config[] = [
  { name: 'shipped', note: 'ctx 32768, fa auto, kv f16', args: [...BASE] },
  { name: 'fa-on', note: 'ctx 32768 + flash attention forced on', args: [...BASE, '-fa', 'on'] },
  { name: 'kv-q8', note: 'ctx 32768 + K/V cache q8_0', args: [...BASE, '-ctk', 'q8_0', '-ctv', 'q8_0'] },
  { name: 'ctx-8k', note: 'ctx 8192, kv f16', args: ['--ctx-size', '8192', '--parallel', '1', '-ngl', '99', '--no-mmproj-offload'] },
  { name: 'ctx-8k-kv-q8', note: 'ctx 8192 + K/V q8_0', args: ['--ctx-size', '8192', '--parallel', '1', '-ngl', '99', '--no-mmproj-offload', '-ctk', 'q8_0', '-ctv', 'q8_0'] },
  { name: 'ctx-16k-kv-q8-fa', note: 'ctx 16384 + K/V q8_0 + fa on', args: ['--ctx-size', '16384', '--parallel', '1', '-ngl', '99', '--no-mmproj-offload', '-ctk', 'q8_0', '-ctv', 'q8_0', '-fa', 'on'] },
];

/*
 * Multi-token prediction. Gemma 4 ships a co-trained "assistant" drafter that
 * shares activations with the base model, so unlike ordinary speculative
 * decoding it needs no second full model in VRAM — the E4B drafter is ~99 MB.
 * Output is guaranteed identical to normal generation; only the speed changes.
 */
if (DRAFTER) {
  for (const n of [3, 5]) {
    CONFIGS.push({
      name: `mtp-n${n}`,
      note: `ctx 32768 + MTP drafter, ${n} draft tokens`,
      args: [...BASE, '--spec-type', 'draft-mtp', '--spec-draft-model', DRAFTER, '--spec-draft-n-max', String(n), '-ngld', '99'],
    });
  }
}

// CPU-only, swept over thread counts, plus the shipped KV quantisation.
for (const t of [6, 8, 12, 16]) {
  CONFIGS.push({
    name: `cpu-t${t}`,
    note: `CPU only (-ngl 0), ${t} threads`,
    args: [...CPU, '-ctk', 'q8_0', '-ctv', 'q8_0', '-t', String(t)],
  });
}
if (DRAFTER) {
  CONFIGS.push({
    name: 'cpu-t8-mtp',
    note: 'CPU only, 8 threads + MTP drafter',
    args: [...CPU, '-ctk', 'q8_0', '-ctv', 'q8_0', '-t', '8',
      '--spec-type', 'draft-mtp', '--spec-draft-model', DRAFTER, '--spec-draft-n-max', '3', '-ngld', '0'],
  });
}
// No -t at all, to find out what llama.cpp picks unaided.
CONFIGS.push({
  name: 'cpu-default-t',
  note: 'CPU only, llama.cpp default thread count',
  args: [...CPU, '-ctk', 'q8_0', '-ctv', 'q8_0'],
});
// Half on each, for a machine that wants to share rather than choose.
CONFIGS.push({
  name: 'split-ngl16',
  note: 'half the layers on the GPU (-ngl 16)',
  args: ['--ctx-size', '32768', '--parallel', '1', '-ngl', '16', '--no-mmproj-offload', '-ctk', 'q8_0', '-ctv', 'q8_0'],
});

// --------------------------------------------------------------------- VRAM

/**
 * What llama-server itself is holding, in MiB.
 *
 * Two earlier attempts were wrong and are worth recording so nobody repeats
 * them. `llama-server --list-devices` reports the driver's view from a FRESH
 * process and does not see another process's allocations — it returned an
 * identical number for every config and made the whole column read zero. The
 * GPU *Adapter* counter does see real usage but is a whole-card total: on this
 * desktop it sat at 12.5 GB with no engine running at all, so the engine's own
 * cost vanished into the noise of everything else on the display.
 *
 * Per-PROCESS counters are attributable, which is what a comparison between
 * configs needs. Dedicated and Shared are summed because Vulkan on this driver
 * puts most of the weights in shared host-visible memory, and reading either
 * alone understates it badly.
 */
function serverGpuMiB(pid: number): { gpu: number; ram: number } | null {
  try {
    const ps = [
      `$p = Get-Process -Id ${pid} -EA SilentlyContinue; if (-not $p) { '0 0'; exit }`,
      `$d = (Get-Counter "\\GPU Process Memory(*)\\Dedicated Usage" -EA SilentlyContinue).CounterSamples |`,
      `  Where-Object { $_.InstanceName -match "pid_${pid}_" } | Measure-Object CookedValue -Sum`,
      `$s = (Get-Counter "\\GPU Process Memory(*)\\Shared Usage" -EA SilentlyContinue).CounterSamples |`,
      `  Where-Object { $_.InstanceName -match "pid_${pid}_" } | Measure-Object CookedValue -Sum`,
      `"$([math]::Round(($d.Sum + $s.Sum)/1MB,0)) $([math]::Round($p.WorkingSet64/1MB,0))"`,
    ].join('\n');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8', timeout: 60_000,
    });
    const [g, r] = out.trim().split(/\s+/).map(Number);
    return Number.isFinite(g) ? { gpu: g, ram: Number.isFinite(r) ? r : 0 } : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- server

async function waitReady(ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/v1/models`, {
        headers: { Authorization: `Bearer ${KEY}` },
      });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function start(cfg: Config): ChildProcess {
  return spawn(
    EXE,
    [
      '--model', MODEL, '--mmproj', MMPROJ,
      '--host', '127.0.0.1', '--port', String(PORT), '--api-key', KEY,
      ...cfg.args,
    ],
    { stdio: 'ignore' },
  );
}

async function stop(p: ChildProcess): Promise<void> {
  p.kill();
  await new Promise((r) => setTimeout(r, 2500));
}

// ----------------------------------------------------------------- workloads

const LONG_SYSTEM =
  'You are an operations officer on a private comm channel in the Elite Dangerous universe. ' +
  'Answer from the facts provided and never invent places, prices, mechanics or events. '.repeat(60);

interface Shot { ms: number; prompt: number; gen: number; prefillPerSec: number; genPerSec: number }

/**
 * One request.
 *
 * `nonce` exists to defeat llama.cpp's prompt cache. Without it the second and
 * third repetition of a config reuse the cached prefix, `prompt_n` collapses to
 * a handful of tokens, and prompt_per_second stops describing prefill at all —
 * the first run of this harness reported "20 tok/s" for a prompt it had
 * actually processed in well under a second.
 */
async function shot(messages: unknown[], maxTokens: number, nonce = ''): Promise<Shot | null> {
  const t0 = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: nonce
          ? [{ role: 'system', content: `Session ${nonce}.` }, ...(messages as object[])]
          : messages,
        max_tokens: maxTokens, temperature: 0.8, stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    // llama.cpp reports prefill and generation separately. Deriving a rate from
    // wall-clock and total tokens blends the two and is simply wrong: a
    // 2,900-token prompt with a 35-token answer reads as "8 tok/s" either way.
    const t = j.timings ?? {};
    return {
      ms: Date.now() - t0,
      prompt: j.usage?.prompt_tokens ?? 0,
      gen: j.usage?.completion_tokens ?? 0,
      prefillPerSec: t.prompt_per_second ?? 0,
      genPerSec: t.predicted_per_second ?? 0,
    };
  } catch {
    return null;
  }
}

const COMMS = [
  { role: 'system', content: 'You write short overheard radio exchanges in the Elite Dangerous universe. Every line is under twelve words. Write exactly 2 lines, one per line, nothing else.' },
  { role: 'user', content: 'WHERE THIS IS HAPPENING:\nSystem: Deciat — High security, Independent, Feudal, Industrial economy, population 31,778,844\nRuns this system: Ryders of the Void (51.6%)\nAlso here: Independent Deciat Green Party (16.5%) · Windri & Co (9.9%)\nSignals detected: Conflict Zone [High Intensity] · Green Moon Steading\n\nWHO IS SPEAKING:\n1. Yusuf Fiore\n2. Dmitri Sarkis\n\nWrite the 2 lines now.' },
];

const COPILOT = [
  { role: 'system', content: LONG_SYSTEM },
  { role: 'user', content: 'The commander just docked at Farseer Inc after a long haul. Say something worth hearing, in two or three short sentences.' },
];

const med = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// ---------------------------------------------------------------------- main

async function main() {
  console.log(`Model: ${MODEL_ID}   reps: ${REPS}   port: ${PORT}\n`);
  console.log("GPU is llama-server's own dedicated+shared GPU memory; RAM is its working set.\n");

  const rows: Array<Record<string, string>> = [];

  const only = arg('only', '');
  const chosen = only ? CONFIGS.filter((c) => only.split(',').includes(c.name)) : CONFIGS;
  for (const cfg of chosen) {
    process.stdout.write(`▶ ${cfg.name.padEnd(16)} ${cfg.note}\n`);
    const t0 = Date.now();
    const proc = start(cfg);
    const up = await waitReady(180_000);
    const loadMs = Date.now() - t0;
    if (!up) {
      console.log(`   FAILED to start\n`);
      rows.push({ config: cfg.name, vram: 'fail', ram: '-', load: '-', comms: '-', copilot: '-', prefill: '-', gen: '-' });
      await stop(proc);
      continue;
    }

    // Warm it first: buffers are allocated lazily, so sampling before any work
    // has run measures a model that has not finished arriving on the card.
    await shot(COMMS, 200);
    await shot(COPILOT, 64);
    const mem = proc.pid ? serverGpuMiB(proc.pid) : null;
    const used = mem?.gpu ?? null;
    const ram = mem?.ram ?? null;

    const c: Shot[] = [], o: Shot[] = [];
    for (let i = 0; i < REPS; i++) {
      const tag = `${cfg.name}-${i}-${Math.round(Date.now() % 1e7)}`;
      const a = await shot(COMMS, 700, `c${tag}`); if (a) c.push(a);
      const b = await shot(COPILOT, 200, `o${tag}`); if (b) o.push(b);
    }

    const commsMs = med(c.map((x) => x.ms));
    const copMs = med(o.map((x) => x.ms));
    // Prefill rate from the long-prompt run; generation rate from its output.
    const prefill = o.length ? Math.round(med(o.map((x) => x.prefillPerSec))) : 0;
    // Generation rate from the run that actually generates: the copilot answer
    // is long enough for the per-token cost to dominate its own measurement.
    const genRate = o.length ? Math.round(med(o.map((x) => x.genPerSec))) : 0;
    const promptN = o.length ? Math.round(med(o.map((x) => x.prompt))) : 0;
    const genN = o.length ? Math.round(med(o.map((x) => x.gen))) : 0;

    console.log(
      `   GPU ${String(used ?? '?').padStart(5)} MiB · RAM ${String(ram ?? '?').padStart(5)} MiB · load ${String(Math.round(loadMs / 100) / 10).padStart(5)}s · ` +
      `comms ${String(commsMs).padStart(5)}ms · copilot ${String(copMs).padStart(5)}ms · ` +
      `prefill ~${prefill} tok/s · gen ~${genRate} tok/s\n`,
    );
    rows.push({
      config: cfg.name,
      vram: String(used ?? '?'),
      ram: String(ram ?? '?'),
      load: `${Math.round(loadMs / 100) / 10}s`,
      comms: `${commsMs}ms`,
      copilot: `${copMs}ms`,
      prefill: `${prefill}/s`,
      gen: `${genRate}/s`,
    });

    await stop(proc);
  }

  console.log('\n' + '='.repeat(92));
  console.log(
    'config'.padEnd(18) + 'GPU MiB'.padStart(9) + 'RAM MiB'.padStart(9) + 'load'.padStart(8) +
    'comms'.padStart(10) + 'copilot'.padStart(10) + 'prefill'.padStart(10) + 'gen'.padStart(9),
  );
  console.log('-'.repeat(92));
  for (const r of rows) {
    console.log(
      r.config.padEnd(18) + r.vram.padStart(9) + r.ram.padStart(9) + r.load.padStart(8) +
      r.comms.padStart(10) + r.copilot.padStart(10) + r.prefill.padStart(10) + r.gen.padStart(9),
    );
  }
  console.log('='.repeat(92));
}

void main();
