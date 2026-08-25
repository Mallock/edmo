/**
 * Show the same facts differently each time.
 *
 * Every brief this app builds caps its lists — four factions, five stations,
 * six signals — and every one of them took `slice(0, cap)`: the same first N,
 * in the same order, for ever. A system with six factions had two the model
 * never saw, and the four it did see arrived in an identical block on every
 * single call.
 *
 * That matters more than it sounds. The comms tier already learned this lesson
 * once and wrote it down on `SceneRequest.situation`: a model handed identical
 * input returns its favourite answer AT ANY TEMPERATURE. Temperature varies the
 * wording; only the input varies the idea. Rotating the window is the cheapest
 * possible way to vary the input without inventing anything — the same true
 * facts, a different subset in a different order, and over enough calls
 * everything gets its turn.
 *
 * Deterministic on purpose. The rotation comes in as a number the caller owns
 * (an edition counter, a write counter), so the briefs stay pure functions that
 * can be tested, and two runs from the same state are reproducible. Nothing
 * here calls Math.random().
 */

/** A capped window over `xs`, starting `rotate` items in and wrapping. */
export function rotateWindow<T>(
  xs: readonly T[],
  cap: number,
  rotate = 0,
): { shown: T[]; more: number } {
  const n = xs.length;
  if (n === 0 || cap <= 0) return { shown: [], more: Math.max(0, n) };
  if (n <= cap) return { shown: [...xs], more: 0 };
  // Non-negative, so a caller that hands over a decreasing counter still works.
  const start = ((rotate % n) + n) % n;
  const shown: T[] = [];
  for (let i = 0; i < cap; i++) shown.push(xs[(start + i) % n]);
  return { shown, more: n - cap };
}

/**
 * The list in a rotated ORDER, keeping every item.
 *
 * For lists short enough to print whole, where the repetition to break is the
 * order rather than the selection.
 */
export function rotateAll<T>(xs: readonly T[], rotate = 0): T[] {
  const n = xs.length;
  if (n <= 1) return [...xs];
  const start = ((rotate % n) + n) % n;
  return [...xs.slice(start), ...xs.slice(0, start)];
}
