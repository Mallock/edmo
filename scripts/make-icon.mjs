// Generates src-tauri/app-icon.png (1024×1024 RGBA) with zero dependencies:
// a dark-navy rounded tile with an amber targeting reticle and cyan ship
// diamond — the ED cockpit palette. Feed the result to `npx tauri icon`.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const C = SIZE / 2;

const NAVY = [10, 22, 40, 255];
const NAVY_EDGE = [16, 34, 60, 255];
const AMBER = [240, 160, 48, 255];
const CYAN = [64, 208, 240, 255];
const NONE = [0, 0, 0, 0];

function pixel(x, y) {
  const dx = x - C;
  const dy = y - C;
  const r = Math.hypot(dx, dy);

  // Rounded-rect tile mask (radius 170).
  const rad = 170;
  const hx = Math.max(0, Math.abs(dx) - (C - rad));
  const hy = Math.max(0, Math.abs(dy) - (C - rad));
  if (Math.hypot(hx, hy) > rad) return NONE;

  // Center diamond (ship marker).
  if (Math.abs(dx) + Math.abs(dy) < 110) return CYAN;

  // Reticle ring.
  if (r >= 300 && r <= 348) return AMBER;

  // Crosshair ticks (N/S/E/W), leaving a gap around the diamond and ring.
  const tick = (a, b) => a < 20 && b > 220 && b < 430 && !(b > 290 && b < 358);
  if (tick(Math.abs(dx), Math.abs(dy)) || tick(Math.abs(dy), Math.abs(dx))) return AMBER;

  // Subtle inner-edge tint so the tile isn't flat.
  const edge = Math.hypot(hx, hy);
  if (edge > rad - 14) return NAVY_EDGE;
  return NAVY;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = pixel(x, y);
    raw[o++] = r;
    raw[o++] = g;
    raw[o++] = b;
    raw[o++] = a;
  }
}

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src-tauri', 'app-icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
