/**
 * The grammar tier — free, instant, offline, and structurally incapable of lying.
 *
 * Templates carry `<tokens>` that are bound to values supplied by a Brief. A
 * template whose tokens all resolve can only ever say things the brief already
 * contained, which is why the grammar tier skips verification entirely: there
 * is nothing to verify. A template with a token the brief cannot supply is
 * SKIPPED, never rendered — the one outcome worse than silence would be
 * transmitting a literal `<stationname>` over the air.
 *
 * The format is lifted, deliberately, from the reference implementation, whose
 * single most-praised design decision is that users can extend it:
 *
 *     @ShipNamePool
 *     Nostromo
 *     Rocinante
 *     # <ShipNamePool> now resolves in any template below
 *
 *     STATION establish
 *     [control] <station> control to <callsign>, hold at the marker.
 *     [hauler]  Copy, <station>. Holding.
 *
 * A user file is merged over the bundled one. It cannot break the app: a
 * malformed section is reported and skipped, and the bundled grammar always
 * loads. That turns "the chatter got repetitive" from a support burden into
 * something a commander can fix in a text editor, which is exactly how the
 * reference implementation's community has kept its chatter alive for years.
 */
import { figuresIn, normaliseFigure, type Brief } from './brief.ts';
import type { ChannelId, DramaticFunction } from './types.ts';
import { CHANNEL_IDS, DRAMATIC_FUNCTIONS } from './types.ts';
import { MAX_TURNS, type Scene, type SceneTurn } from './scenes.ts';

/** One authored template: a channel, a dramatic function, and its turns. */
export interface Template {
  channel: ChannelId;
  func: DramaticFunction;
  turns: SceneTurn[];
  /** Which brief kinds this template can be filled from. Empty = any. */
  kinds: string[];
  /** Where it came from, for error reporting. */
  origin: 'bundled' | 'user';
  line: number;
}

export interface Grammar {
  templates: Template[];
  /** User-declared token pools, e.g. ShipNamePool -> [names…]. */
  pools: Record<string, string[]>;
  /** Problems found while parsing. Non-fatal by design. */
  errors: string[];
}

const TOKEN_RE = /<([A-Za-z_][A-Za-z0-9_]*)>/g;

/**
 * Parse a grammar file.
 *
 * Never throws. Everything it cannot understand becomes an entry in `errors`
 * and is skipped, because this function parses user-authored text and the
 * bundled grammar has to survive whatever the user's file does.
 */
export function parseGrammar(source: string, origin: 'bundled' | 'user'): Grammar {
  const templates: Template[] = [];
  const pools: Record<string, string[]> = {};
  const errors: string[] = [];

  const lines = source.split(/\r?\n/);
  let poolName: string | null = null;
  let header: { channel: ChannelId; func: DramaticFunction; kinds: string[]; line: number } | null =
    null;
  let turns: SceneTurn[] = [];

  const closeTemplate = (): void => {
    if (!header) return;
    if (!turns.length) {
      errors.push(`line ${header.line}: ${header.channel} ${header.func} has no turns`);
    } else if (turns.length > MAX_TURNS) {
      errors.push(
        `line ${header.line}: ${header.channel} ${header.func} has ${turns.length} turns (max ${MAX_TURNS})`,
      );
    } else if (turns.length > 1 && new Set(turns.map((t) => t.speakerRef)).size < 2) {
      errors.push(
        `line ${header.line}: ${header.channel} ${header.func} is a multi-turn scene with one speaker`,
      );
    } else {
      templates.push({ ...header, turns, origin });
    }
    header = null;
    turns = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const no = i + 1;

    if (!line || line.startsWith('#')) continue;

    // @PoolName — everything until the next directive joins this pool.
    if (line.startsWith('@')) {
      closeTemplate();
      const name = line.slice(1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        errors.push(`line ${no}: bad pool name "${name}"`);
        poolName = null;
        continue;
      }
      poolName = name;
      pools[name] ??= [];
      continue;
    }

    // [speaker] text — a turn of the template currently open.
    const turn = /^\[([^\]]+)\]\s*(.+)$/.exec(line);
    if (turn) {
      poolName = null;
      if (!header) {
        errors.push(`line ${no}: turn outside any scene header`);
        continue;
      }
      turns.push({ speakerRef: turn[1].trim(), text: turn[2].trim() });
      continue;
    }

    // CHANNEL function [kind,kind] — a scene header.
    const head = /^([A-Z]+)\s+([a-z]+)\s*(?:\(([^)]*)\))?$/.exec(line);
    if (head) {
      closeTemplate();
      poolName = null;
      const channel = head[1] as ChannelId;
      const func = head[2] as DramaticFunction;
      if (!CHANNEL_IDS.includes(channel)) {
        errors.push(`line ${no}: unknown channel "${head[1]}"`);
        continue;
      }
      if (!DRAMATIC_FUNCTIONS.includes(func)) {
        errors.push(`line ${no}: unknown dramatic function "${head[2]}"`);
        continue;
      }
      const kinds = (head[3] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      header = { channel, func, kinds, line: no };
      continue;
    }

    // Anything else is a pool member, if a pool is open.
    if (poolName) {
      pools[poolName].push(line);
      continue;
    }

    errors.push(`line ${no}: not a pool entry, scene header or turn — "${line.slice(0, 40)}"`);
  }
  closeTemplate();

  return { templates, pools, errors };
}

/**
 * Merge a user grammar over the bundled one.
 *
 * User templates are ADDED rather than replacing, matching the reference
 * implementation's default; its `REPLACE` directive exists because wholesale
 * replacement is occasionally wanted, but the safe default is additive. User
 * pools of the same name extend the bundled pool rather than clobbering it, so
 * adding two ship names does not delete the other forty.
 */
export function mergeGrammar(bundled: Grammar, user: Grammar | null): Grammar {
  if (!user) return bundled;
  const pools: Record<string, string[]> = { ...bundled.pools };
  for (const [name, members] of Object.entries(user.pools)) {
    pools[name] = [...new Set([...(pools[name] ?? []), ...members])];
  }
  return {
    templates: [...bundled.templates, ...user.templates],
    pools,
    errors: [...bundled.errors, ...user.errors],
  };
}

/** Stable identity for a template — what a listener hears as "that line". */
export function templateKey(t: Template): string {
  return `${t.channel}:${t.origin}:${t.line}`;
}

/** Every token a template needs bound. */
export function tokensOf(t: Template): string[] {
  const out = new Set<string>();
  for (const turn of t.turns) {
    for (const m of turn.text.matchAll(TOKEN_RE)) out.add(m[1]);
  }
  return [...out];
}

/**
 * Can this template be filled from this brief?
 *
 * Checked BEFORE rendering rather than by rendering and inspecting the result,
 * so an unfillable template costs nothing and — more importantly — so there is
 * no code path in which a partially bound string exists at all.
 */
export function canBind(t: Template, brief: Brief, pools: Record<string, string[]>): boolean {
  if (t.kinds.length && !t.kinds.includes(brief.kind)) return false;
  return tokensOf(t).every(
    (name) => brief.tokens[name] !== undefined || (pools[name]?.length ?? 0) > 0,
  );
}

/** Templates that fit this channel, function and brief. */
export function candidates(
  g: Grammar,
  channel: ChannelId,
  func: DramaticFunction,
  brief: Brief,
): Template[] {
  return g.templates.filter(
    (t) => t.channel === channel && t.func === func && canBind(t, brief, g.pools),
  );
}

/**
 * Render a template into a scene, or null when it cannot be fully bound.
 *
 * `rand` is injected so a session is reproducible in tests and so pool picks
 * can be seeded per-system — the same pool should give the same bar its name
 * every time the commander comes back.
 */
export function render(
  t: Template,
  brief: Brief,
  pools: Record<string, string[]>,
  rand: () => number,
  id: string,
  ttlMs: number,
): Scene | null {
  // Pool choices are made once per scene, so a name used twice in an exchange
  // is the same name both times. Choosing per-occurrence produced two
  // different ships answering the same hail, which is worse than no scene.
  const chosen = new Map<string, string>();
  let failed = false;

  const bind = (text: string): string =>
    text.replace(TOKEN_RE, (whole, name: string) => {
      const fromBrief = brief.tokens[name];
      if (fromBrief !== undefined) return fromBrief;
      const already = chosen.get(name);
      if (already !== undefined) return already;
      const pool = pools[name];
      if (pool?.length) {
        const pick = pool[Math.floor(rand() * pool.length) % pool.length];
        chosen.set(name, pick);
        return pick;
      }
      failed = true;
      return whole;
    });

  const turns = t.turns.map((turn) => ({ speakerRef: turn.speakerRef, text: bind(turn.text) }));
  if (failed) return null;

  // Pool picks are inventions the scene has now committed to — a ship name, a
  // grumble, a shift. They are legitimate (nothing checkable is being claimed)
  // but they are NOT in the brief, so the scene would fail its own
  // verification and the panel would mis-attribute them as reported fact.
  //
  // This was a real bug: "Hurston Ring to Tessellate, your slot has moved"
  // asserted a vessel nobody had licensed. Folding the picks in as `cast`
  // nouns is what actually makes the grammar tier unable to lie, rather than
  // merely asserted to be.
  const invented = [...chosen.values()].filter((v) => /^\p{Lu}/u.test(v));

  // Authored literals are trusted for the same reason the authored prose is:
  // a human wrote them, and they assert nothing about game state. Taken from
  // the RAW template — before binding — so only hand-written constants
  // qualify and anything that arrived through a token is left to the brief.
  // Without this, a pool line like "waiting on a slot for two hours" made the
  // scene fail its own verification over the word "two".
  const authoredFigures = new Set<string>();
  for (const turn of t.turns) for (const f of figuresIn(turn.text)) authoredFigures.add(f);
  for (const picked of chosen.values()) {
    for (const f of figuresIn(picked)) authoredFigures.add(f);
  }
  const already = new Set(brief.figures.map((f) => normaliseFigure(f.value)));
  const extraFigures = [...authoredFigures].filter((f) => !already.has(f));

  const sceneBrief: Brief =
    invented.length || extraFigures.length
      ? {
          ...brief,
          nouns: [
            ...brief.nouns,
            ...invented.map((value) => ({ value, source: { kind: 'cast' as const } })),
          ],
          figures: [
            ...brief.figures,
            ...extraFigures.map((value) => ({ value, source: { kind: 'cast' as const } })),
          ],
        }
      : brief;

  return {
    id,
    channel: t.channel,
    func: t.func,
    turns,
    brief: sceneBrief,
    ttlMs,
    tier: 'grammar',
    templateId: templateKey(t),
  };
}
