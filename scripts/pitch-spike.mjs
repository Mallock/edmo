/**
 * Persona pitch spike (tasks 1.1 / 1.2 of add-comms-chatter).
 *
 * The chatter feature wants many apparent speakers out of the two bundled
 * Piper voices. Piper exposes `length_scale` (phoneme duration) but no pitch
 * control, and Web Audio's `playbackRate` shifts pitch and tempo together.
 * The proposed trick is to cancel the tempo change: synthesize SLOW at
 * length_scale = r, play back at rate = r. Duration returns to normal; pitch
 * and formants shift up by r.
 *
 * That is a resampling shift, not a formant-preserving one, so the question is
 * how far r can go before it sounds like a chipmunk — and how much of the
 * damage the radio bandpass hides.
 *
 * This script MEASURES the mechanical half objectively (does duration really
 * come back? does F0 really move by r?) and writes listenable WAVs for the
 * subjective half. Run:  node scripts/pitch-spike.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PIPER = join(ROOT, 'src-tauri/resources/tts/piper/piper.exe');
const VOICES = join(ROOT, 'src-tauri/resources/tts/voices');
const OUT = join(ROOT, 'scratch-pitch-spike');

const LINE =
  'Hurston Ring control, inbound from Ratraii, requesting clearance for pad four.';

/** Rates to probe. 1.0 is the control. */
const RATES = [0.88, 0.94, 1.0, 1.06, 1.12, 1.2];

// ---------------------------------------------------------------------------
// Minimal 16-bit mono WAV read/write (piper emits exactly this)
// ---------------------------------------------------------------------------

function readWav(path) {
  const buf = readFileSync(path);
  // Walk the chunk list rather than assuming a 44-byte header.
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = { channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4) };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`not a usable wav: ${path}`);
  const samples = new Float32Array(data.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { rate: fmt.rate, channels: fmt.channels, samples };
}

function writeWav(path, rate, samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([head, data]));
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** Median F0 over voiced frames, by autocorrelation. Speech range 70-350 Hz. */
function medianF0(samples, rate) {
  const win = Math.floor(rate * 0.04); // 40 ms
  const hop = Math.floor(rate * 0.02);
  const minLag = Math.floor(rate / 350);
  const maxLag = Math.floor(rate / 70);
  const f0s = [];
  for (let start = 0; start + win + maxLag < samples.length; start += hop) {
    let energy = 0;
    for (let i = 0; i < win; i++) energy += samples[start + i] ** 2;
    if (energy / win < 1e-4) continue; // silence / unvoiced
    let bestLag = 0;
    let best = 0;
    let zero = 0;
    for (let i = 0; i < win; i++) zero += samples[start + i] * samples[start + i];
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0;
      for (let i = 0; i < win; i++) acc += samples[start + i] * samples[start + i + lag];
      const norm = acc / (zero + 1e-9);
      if (norm > best) {
        best = norm;
        bestLag = lag;
      }
    }
    if (best > 0.4 && bestLag > 0) f0s.push(rate / bestLag);
  }
  if (!f0s.length) return 0;
  f0s.sort((a, b) => a - b);
  return f0s[Math.floor(f0s.length / 2)];
}

/** Spectral centroid (Hz) — a cheap proxy for where the formant energy sits. */
function centroid(samples, rate) {
  const N = 2048;
  let numAcc = 0;
  let denAcc = 0;
  for (let start = 0; start + N < samples.length; start += N) {
    // Goertzel-free crude DFT over a coarse bin set; enough for a proxy.
    for (let k = 2; k < 96; k++) {
      const freq = (k * rate) / N;
      let re = 0;
      let im = 0;
      for (let n = 0; n < N; n += 2) {
        const ang = (-2 * Math.PI * k * n) / N;
        re += samples[start + n] * Math.cos(ang);
        im += samples[start + n] * Math.sin(ang);
      }
      const mag = Math.sqrt(re * re + im * im);
      numAcc += freq * mag;
      denAcc += mag;
    }
  }
  return denAcc > 0 ? numAcc / denAcc : 0;
}

/** Linear resample — what playbackRate does. rate>1 = faster & higher. */
function resample(samples, factor) {
  const out = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i++) {
    const src = i * factor;
    const i0 = Math.floor(src);
    const frac = src - i0;
    const a = samples[i0] ?? 0;
    const b = samples[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** One-pole-cascade approximation of the radio bandpass, to hear the masking. */
function bandpass(samples, rate, hpfHz, lpfHz) {
  const out = Float32Array.from(samples);
  // 2x one-pole high-pass
  for (let pass = 0; pass < 2; pass++) {
    const rc = 1 / (2 * Math.PI * hpfHz);
    const dt = 1 / rate;
    const a = rc / (rc + dt);
    let prevIn = out[0];
    let prevOut = out[0];
    for (let i = 1; i < out.length; i++) {
      const x = out[i];
      const y = a * (prevOut + x - prevIn);
      prevIn = x;
      prevOut = y;
      out[i] = y;
    }
  }
  // 2x one-pole low-pass
  for (let pass = 0; pass < 2; pass++) {
    const rc = 1 / (2 * Math.PI * lpfHz);
    const dt = 1 / rate;
    const a = dt / (rc + dt);
    let prev = out[0];
    for (let i = 1; i < out.length; i++) {
      prev += a * (out[i] - prev);
      out[i] = prev;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

function synth(voice, lengthScale, outPath) {
  execFileSync(
    PIPER,
    [
      '--model', join(VOICES, `${voice}.onnx`),
      '--output_file', outPath,
      '--length_scale', String(lengthScale),
      '--sentence_silence', '0.25',
    ],
    { input: LINE, stdio: ['pipe', 'ignore', 'ignore'], cwd: join(ROOT, 'src-tauri/resources/tts/piper') },
  );
}

mkdirSync(OUT, { recursive: true });

const voices = ['en_GB-alba-medium', 'en_GB-northern_english_male-medium'];
const report = [];

for (const voice of voices) {
  // Control: normal synthesis, no playback shift.
  const ctlPath = join(OUT, `${voice}_control.wav`);
  synth(voice, 1.0, ctlPath);
  const ctl = readWav(ctlPath);
  const ctlF0 = medianF0(ctl.samples, ctl.rate);
  const ctlDur = ctl.samples.length / ctl.rate;
  const ctlCentroid = centroid(ctl.samples, ctl.rate);

  report.push({
    voice, rate: 1.0, lengthScale: 1.0,
    durSec: +ctlDur.toFixed(3), durErrPct: 0,
    f0: +ctlF0.toFixed(1), f0ShiftPct: 0,
    centroid: +ctlCentroid.toFixed(0),
  });

  for (const r of RATES) {
    if (r === 1.0) continue;
    // synth slow by r, then play back at r
    const rawPath = join(OUT, `${voice}_ls${r}.wav`);
    synth(voice, r, rawPath);
    const raw = readWav(rawPath);
    const shifted = resample(raw.samples, r);

    const dur = shifted.length / raw.rate;
    const f0 = medianF0(shifted, raw.rate);
    const cen = centroid(shifted, raw.rate);

    writeWav(join(OUT, `${voice}_persona_r${r}.wav`), raw.rate, shifted);
    writeWav(
      join(OUT, `${voice}_persona_r${r}_radio.wav`),
      raw.rate,
      bandpass(shifted, raw.rate, 300, 3400),
    );

    report.push({
      voice, rate: r, lengthScale: r,
      durSec: +dur.toFixed(3),
      durErrPct: +(((dur - ctlDur) / ctlDur) * 100).toFixed(1),
      f0: +f0.toFixed(1),
      f0ShiftPct: ctlF0 ? +(((f0 - ctlF0) / ctlF0) * 100).toFixed(1) : 0,
      centroid: +cen.toFixed(0),
    });
  }
}

console.table(report);
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\nWAVs written to ${OUT}`);
console.log('Compare *_control.wav against *_persona_r*.wav (dry) and *_radio.wav (bandpassed).');
