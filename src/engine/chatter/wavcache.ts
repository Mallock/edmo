/**
 * The synthesized-speech cache key and its LRU.
 *
 * Comms traffic repeats itself by design — traffic control says close to the
 * same thing every approach, and a persona's stock phrases are stock on
 * purpose. Synthesizing those again every time is the difference between
 * ambience that is free and ambience that costs a sidecar round trip and a
 * neural forward pass per line, forever.
 *
 * Two layers cache it. The sidecar writes WAVs to the app-data dir, so a line
 * survives a restart. This one sits in front and saves the IPC hop for lines
 * repeated within a session, which after an hour of chatter is most of them.
 *
 * Kept here rather than inside the Speaker so the key rule and the eviction
 * order can be tested without a DOM, an audio device or a running sidecar.
 */

/**
 * The cache key.
 *
 * Exactly the three inputs Piper is given: identical keys therefore guarantee
 * identical audio. `lengthScale` is rounded to three places because personas
 * derive it by multiplication (design D7a) and floating-point noise in the
 * last digits would otherwise turn one voice into a thousand cache misses.
 */
export function synthKey(
  text: string,
  voice: string | null | undefined,
  lengthScale: number,
): string {
  return `${voice ?? ''}|${lengthScale.toFixed(3)}|${text}`;
}

/**
 * Bounded LRU over anything.
 *
 * Backed by a Map, whose iteration order is insertion order — so a `get` that
 * re-inserts moves the entry to the young end, and eviction takes the first
 * key. That is the whole trick; there is no separate recency list to keep in
 * sync, which is where hand-rolled LRUs usually go wrong.
 */
export class LruCache<V> {
  private map = new Map<string, V>();
  private readonly cap: number;
  /** Counters, so a soak run can show whether the cache is earning its keep. */
  private hits = 0;
  private misses = 0;

  constructor(cap: number) {
    this.cap = Math.max(1, cap);
  }

  get size(): number {
    return this.map.size;
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.map.size };
  }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (hit === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Keys from least to most recently used — eviction order. */
  keys(): string[] {
    return [...this.map.keys()];
  }

  clear(): void {
    this.map.clear();
  }
}
