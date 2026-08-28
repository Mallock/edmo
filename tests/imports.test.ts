/**
 * Nothing may call a function it never imported.
 *
 * This test exists because two shipped bugs were the same typo, and neither
 * was catchable by anything else in the project:
 *
 *   store.ts  called `towerBrief(...)` without importing it, so EVERY docking
 *             event threw a ReferenceError out of maybeComms — which is called
 *             straight from the journal handler with no try around it, so the
 *             rest of that pass was abandoned too. The tower never once spoke.
 *
 *   tts.ts    called `profileFor(utt.profile, s)` — a function that does not
 *             exist in that module; the only one in the codebase takes a model
 *             id and one argument. Every Edge utterance that reached the radio
 *             bus died on it.
 *
 * Both are ordinary TypeScript errors (TS2304, "cannot find name"). Nothing
 * reports them here: `typescript` is not a dependency, Vite builds with esbuild
 * which strips types without checking them, and `node --experimental-strip-types`
 * does the same. The tests import the modules, but a ReferenceError inside a
 * branch no test reaches is invisible — which is exactly where both of these
 * lived.
 *
 * So this walks the source instead. It is a blunt instrument and deliberately
 * so: it only knows about names the project itself exports, and only flags them
 * where they are CALLED and not in scope. That is narrow enough to be quiet and
 * wide enough to have caught both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['src'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (['.ts', '.tsx'].includes(extname(entry.name))) out.push(p);
  }
  return out;
}

/**
 * Comments and quoted strings, blanked out.
 *
 * Without this the check is useless: a doc comment saying "precomputed by
 * describeShip(ship)" reads exactly like a call, and both of the real bugs
 * would have been buried in false positives nobody would trust.
 *
 * Template literals are deliberately left ALONE. An earlier version tried to
 * keep only their `${...}` holes and quietly ate everything else — including,
 * in llm.ts, the `export function parseSceneReply` declaration sitting after a
 * few hundred lines of prompt text, which the check then reported as an
 * unimported call to itself. Leaving them whole costs nothing: prose only
 * trips this if it happens to read as `someExportedName(`.
 */
function stripNonCode(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r));

/** Every function-shaped name the project exports anywhere. */
const exported = new Set<string>();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/^export (?:async )?function (\w+)|^export const (\w+)\s*[:=]/gm)) {
    exported.add(m[1] ?? m[2]);
  }
}

test('no module calls a project function it has not imported', () => {
  const offences: string[] = [];

  for (const f of files) {
    const raw = readFileSync(f, 'utf8');
    const code = stripNonCode(raw);

    // Names in scope: anything imported, and anything declared locally.
    //
    // Declarations are read from the RAW source on purpose. Reading them from
    // the stripped copy was wrong twice over — an apostrophe inside a template
    // literal ("the speaker's seat") opens a string as far as this scanner is
    // concerned and swallows the next declaration whole. Over-counting scope
    // only ever makes this test quieter, never wronger: a name that IS declared
    // somewhere in the file is not the bug being hunted.
    const scope = new Set<string>();
    for (const m of raw.matchAll(/(?:function|const|let|var|class)\s+(\w+)/g)) scope.add(m[1]);
    for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}/gs)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().replace(/^type\s+/, '');
        if (name) scope.add(name.split(/\s+as\s+/).pop()!.trim());
      }
    }
    for (const m of code.matchAll(/import\s+(\w+)\s+from/g)) scope.add(m[1]);

    // Called, but not in scope, and a name this project actually exports —
    // the `.` guard keeps method calls (this.foo(), obj.foo()) out of it.
    for (const m of code.matchAll(/(?<![.\w$])([a-z]\w+)\s*\(/g)) {
      const name = m[1];
      if (exported.has(name) && !scope.has(name)) {
        offences.push(`${f}: calls ${name}() but never imports it`);
      }
    }
  }

  assert.deepEqual([...new Set(offences)], [], `\n  ${[...new Set(offences)].join('\n  ')}\n`);
});
