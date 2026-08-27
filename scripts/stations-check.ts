/**
 * Are the stations still on the air?
 *
 * The unit tests pin the SHAPE of the dial — ids, endpoints, the chapter
 * mapping — but they cannot tell you that a stream host moved, renamed a
 * mount or dropped its CORS header, which is exactly how a radio feature rots.
 * This asks each station for the first kilobyte and reports what came back.
 *
 *   npx tsx scripts/stations-check.ts
 */
import { STATIONS } from '../src/engine/stations.ts';

async function head(url: string): Promise<{ code: number; type: string; cors: boolean }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-1023' }, signal: ctl.signal });
    // Read a little so the connection is real, then drop it.
    await res.body?.cancel();
    return {
      code: res.status,
      type: res.headers.get('content-type') ?? '?',
      cors: res.headers.get('access-control-allow-origin') === '*',
    };
  } catch (e) {
    return { code: 0, type: String(e).slice(0, 40), cors: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read one channel's track off Nightride's event stream.
 *
 * The stream carries every channel and only speaks when something changes, so
 * a station that has not turned a record over yet may take a moment. It is
 * given a window rather than a single frame, and the connection is dropped as
 * soon as the right row arrives.
 */
async function sseTrack(url: string, channel: string, windowMs = 12_000): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), windowMs);
  try {
    const res = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: ctl.signal });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
      for (const line of buf.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const rows = JSON.parse(line.slice(5).trim()) as Array<{
            station?: string;
            artist?: string;
            title?: string;
          }>;
          const row = rows.find((r) => r.station === channel);
          if (row) {
            await reader.cancel().catch(() => {});
            return [row.artist, row.title].filter(Boolean).join(' — ') || null;
          }
        } catch {
          /* partial frame — wait for more bytes */
        }
      }
      // Keep only the tail, so a long-lived stream does not grow a buffer.
      buf = buf.slice(Math.max(0, buf.lastIndexOf('\n')));
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  let bad = 0;
  console.log('STATION            CODE  TYPE                  CORS  ROUTABLE MATCHES?');
  for (const s of STATIONS) {
    const r = await head(s.url);
    const ok = r.code >= 200 && r.code < 400;
    // The catalogue's `routable` flag is a promise about ducking — if the
    // header no longer agrees, the station plays but ducks the crude way.
    const agrees = r.cors === s.routable;
    if (!ok || !agrees) bad++;
    console.log(
      `${s.id.padEnd(18)}${String(r.code).padStart(4)}  ${r.type.slice(0, 20).padEnd(22)}${
        r.cors ? 'yes ' : 'no  '
      }  ${String(s.routable).padEnd(9)}${agrees ? '' : '  << catalogue disagrees'}${
        ok ? '' : '  << DEAD'
      }`,
    );
    if (s.track?.kind === 'somafm') {
      try {
        const res = await fetch(s.track.url, { cache: 'no-store' });
        const j = (await res.json()) as { songs?: Array<{ artist?: string; title?: string }> };
        const song = j.songs?.[0];
        console.log(`  ♫ ${[song?.artist, song?.title].filter(Boolean).join(' — ') || '(no track)'}`);
      } catch {
        console.log('  ♫ (now-playing unavailable)');
        bad++;
      }
    } else if (s.track?.kind === 'nightride') {
      const line = await sseTrack(s.track.url, s.track.channel);
      if (line) console.log(`  ♫ ${line}`);
      else {
        console.log('  ♫ (no frame for this channel within the window)');
        bad++;
      }
    }
  }
  console.log(bad ? `\n${bad} problem(s) — the dial needs attention.` : '\nAll stations on the air.');
}

void main();
