/**
 * Local system news — a fictional wire service for wherever the commander is.
 *
 * Galnet reports the galaxy. Nothing reports HIP 71120: who runs it, who is
 * gaining on them, what the construction sites are short of, which rings are
 * being worked. The journal knows all of it and states none of it as a story.
 *
 * So the model writes the paper — but it does not get to invent the facts. It
 * is handed a brief of things that are TRUE right now, and every name it may
 * print. Anything else is a fabrication and the item is dropped, because a
 * local paper that invents a faction is worse than no paper at all.
 *
 * Pure module — unit-tested in tests/news.test.ts.
 */
import type { OperatorState, SystemIntel } from './types.ts';
import type { MarketRecord } from './trade.ts';
import { isNearDuplicate } from './copilot.ts';
import { rotateWindow } from './rotate.ts';
import { isModelAside, stripModelAside } from './aside.ts';
import { newsAngle } from './tone.ts';
import { describeSignal, stateGlossary } from './gloss.ts';

/**
 * The desks the paper runs.
 *
 * A wire that only reports influence percentages is an almanac. Real local
 * papers carry the dock league, the cargo thefts and the ring-shift gossip —
 * none of which the journal knows, all of which belong to this system.
 *
 * civic and industry are reported from journal fact. crime is anchored to the
 * security rating and the doors that have actually been shut in the
 * commander's face. sport and life are invention — but invention that is kept
 * (see NewsCast), so the dock league has the same two teams next week.
 */
export type NewsDesk =
  | 'civic'
  | 'industry'
  | 'economy'
  | 'crime'
  | 'sport'
  | 'life'
  | 'gossip'
  | 'celebrity';

export const DESK_LABEL: Readonly<Record<NewsDesk, string>> = {
  civic: 'Civic',
  industry: 'Industry',
  economy: 'Economy',
  crime: 'Crime',
  sport: 'Sport',
  life: 'Life',
  gossip: 'Gossip',
  celebrity: 'Celebrity',
};

const DESK_BRIEF: Readonly<Record<NewsDesk, string>> = {
  civic: 'the faction board — who holds influence, who is gaining, what state they are in',
  industry: 'work — the construction sites, mining and extraction, what is being built and dug',
  economy:
    'prices — quote the MOVE, SPREAD and DEMAND lines as a market report would. Name the commodity, ' +
    'the station and the figure. Never invent a price or a direction the brief does not state',
  crime: 'crime and security — the security rating, thefts, piracy on the lanes, doors shut to hauliers',
  sport:
    'sport — the low-gravity leagues, dock-crew races, ring-runner time trials. Invent the fixtures ' +
    'and the results, but keep the SAME teams and venues you have used before',
  life:
    'ordinary life — bars, shift patterns, weddings, complaints, the concourse. Invent the people, ' +
    'but keep the SAME people you have used before',
  gossip:
    'the rumour mill — who fell out with whom on the dock, what the night shift is saying, which ' +
    'contract everybody knows is going badly. Attribute it to nobody and believe none of it. ' +
    'Invent the people, and keep the SAME people you have used before',
  celebrity:
    'local fame — a ring-runner with a following, a station manager who gave a speech, a haulier ' +
    'who got rich and will not stop mentioning it. Treat their importance as the joke. Invent them, ' +
    'and keep the SAME ones you have used before',
};

/**
 * Desks allowed to make people up.
 *
 * The reported desks work from the journal and may invent nothing. These four
 * are fiction by definition — the game has no dock league and no barman — and
 * they are what stop the paper being an almanac.
 */
const INVENTS = new Set<NewsDesk>(['sport', 'life', 'gossip', 'celebrity', 'crime']);

/** An invented thing the paper has committed to: a team, a bar, a person. */
export interface CastMember {
  name: string;
  /** Which desk brought them into existence. */
  desk: NewsDesk;
  /** ISO of first appearance. */
  firstAt: string;
  /** ISO of the most recent mention. */
  lastAt: string;
  mentions: number;
}

/** One story on the wire. */
export interface NewsItem {
  /** Short front-page headline. */
  headline: string;
  /** One or two sentences under it. */
  body: string;
  /** When it was written (ISO). */
  at: string;
  /** The system it is about — a paper does not follow the commander. */
  system: string;
  /** Which desk filed it. */
  desk: NewsDesk;
}

/** How often the wire refreshes. Off is a real choice, not a hidden default. */
export const NEWS_INTERVALS = [0, 10, 20, 30, 60] as const;
export type NewsInterval = (typeof NEWS_INTERVALS)[number];

export const newsIntervalLabel = (m: number): string =>
  m <= 0 ? 'Off' : m >= 60 ? 'Hourly' : `Every ${m} min`;

/**
 * Which desks can file from this brief, and in what order.
 *
 * civic and industry need facts to report and are skipped when the brief has
 * none — a paper with no faction board should not run a politics story. sport
 * and life always run, because they are invented, and they are what stop four
 * consecutive editions from being four readings of the same influence figure.
 */
export function desksFor(brief: readonly string[], edition = 0, perEdition = 1): NewsDesk[] {
  const has = (p: string): boolean => brief.some((l) => l.startsWith(p));
  const pool: NewsDesk[] = [];
  if (has('FACTION:') || has('CONTROLLING FACTION:')) pool.push('civic');
  if (has('CONSTRUCTION:') || has('SIGNAL:') || has('MARKET:')) pool.push('industry');
  // Only when there is actually a price story: a board with no movement, no
  // spread and no demand is a listing, and a listing is not a market report.
  if (has('MOVE:') || has('SPREAD:') || has('DEMAND:')) pool.push('economy');
  if (has('SECURITY:') || has('DENIED:') || has('SYSTEM:')) pool.push('crime');
  pool.push('sport', 'life', 'gossip', 'celebrity');
  // Advance by a WHOLE edition, not by one desk.
  //
  // Rotating by one meant consecutive editions shared all but one desk — file
  // civic/industry/economy, then industry/economy/crime ten minutes later — so
  // the same desk re-reported the same standing fact twice running, which is
  // where the duplicates came from. It also meant the invented desks sat at the
  // back of the queue and never came up: a commander watched the wire all
  // evening and never once saw sport.
  const stride = Math.max(1, perEdition);
  const at = (((edition * stride) % pool.length) + pool.length) % pool.length;
  return [...pool.slice(at), ...pool.slice(0, at)];
}

/** Extra grounding the store can hand over beyond the raw system state. */
export interface NewsExtras {
  /** Stations that have refused the commander docking — crime-desk material. */
  denials?: string[];
  /** Recurring invented people, teams and venues this paper has committed to. */
  cast?: readonly CastMember[];
  /** Headlines already published here, so a story can follow one up. */
  previously?: readonly string[];
  /** Construction sites being supplied here, and what they still want. */
  construction?: Array<{ station: string; remaining: number; pct: number; top: string[] }>;
  /** Stations the commander has read a market at, in this system. */
  markets?: Array<{ station: string; sells: string[] }>;
  /** Community goals running here. */
  goals?: Array<{ title: string; market: string; contributors: number }>;
  /** Market-report lines from marketPulse(): MOVE, SPREAD and DEMAND. */
  pulse?: readonly string[];
  /** What the commander has actually done here this session — the paper's
   *  "local trader" angle, and the only place they appear at all. */
  commanderDid?: string[];
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/**
 * The facts the paper is allowed to print, as plain lines.
 *
 * Deliberately dense and unliterary. Every line is something the journal said;
 * the model's whole job is to choose among them and write them up, never to
 * add to them.
 */
export function buildNewsBrief(
  system: string,
  intel: SystemIntel | undefined,
  extras: NewsExtras = {},
  /**
   * Which slice of each capped list to print, so two editions from an unchanged
   * system are not built from byte-identical input.
   *
   * The desks already rotate; the FACTS under them did not. A system with ten
   * stations showed the same eight for ever, so the industry desk reported the
   * same places week after week and the model, handed identical text, returned
   * its favourite answer — which no temperature setting can fix. Pass the
   * edition counter. See rotate.ts.
   */
  rotate = 0,
): string[] {
  const out: string[] = [];
  if (!system || system === 'unknown') return out;
  const bits: string[] = [];
  if (intel?.population != null) bits.push(`population ${intel.population.toLocaleString('en-US')}`);
  if (intel?.economy) bits.push(`${intel.economy} economy`);
  if (intel?.government) bits.push(intel.government);
  if (intel?.security) bits.push(intel.security);
  if (intel?.allegiance) bits.push(intel.allegiance);
  out.push(`SYSTEM: ${system}${bits.length ? ` — ${bits.join(', ')}.` : '.'}`);

  if (intel?.controllingFaction) out.push(`CONTROLLING FACTION: ${intel.controllingFaction}.`);
  for (const f of intel?.factions ?? []) {
    out.push(
      `FACTION: ${f.name} — ${pct(f.influence)} influence${f.state ? `, in ${f.state}` : ''}${
        f.allegiance ? `, ${f.allegiance}` : ''
      }.`,
    );
  }
  // The desks are told what those state words mean — a paper covering an
  // "Outbreak" it cannot define writes around its own front page (gloss.ts).
  const glossary = stateGlossary((intel?.factions ?? []).map((f) => f.state));
  if (glossary) out.push(glossary);

  const stations = (intel?.signals ?? []).filter((s) => s.isStation).map((s) => s.name);
  for (const s of rotateWindow(stations, 8, rotate).shown) out.push(`STATION: ${s}.`);
  const sites = (intel?.signals ?? [])
    .filter((s) => !s.isStation && s.type)
    .map(describeSignal);
  for (const s of rotateWindow([...new Set(sites)], 6, rotate).shown) out.push(`SIGNAL: ${s}.`);

  for (const c of extras.construction ?? []) {
    out.push(
      `CONSTRUCTION: ${c.station} is ${c.pct.toFixed(0)}% built and still wants ${Math.round(
        c.remaining,
      ).toLocaleString('en-US')} t${c.top.length ? `, mostly ${c.top.slice(0, 3).join(', ')}` : ''}.`,
    );
  }
  for (const m of extras.markets ?? []) {
    if (m.sells.length) out.push(`MARKET: ${m.station} is selling ${m.sells.slice(0, 4).join(', ')}.`);
  }
  for (const p of extras.pulse ?? []) out.push(p);
  for (const g of extras.goals ?? []) {
    out.push(`COMMUNITY GOAL: "${g.title}" at ${g.market}, ${g.contributors.toLocaleString('en-US')} pilots signed on.`);
  }
  for (const d of extras.denials ?? []) out.push(`DENIED: ${d} has refused hauliers docking.`);
  for (const d of extras.commanderDid ?? []) out.push(`LOCAL TRADER: ${d}`);
  // The paper's own continuity. Listed last so the facts lead, but listed —
  // without it the sport desk invents two new teams every single edition.
  for (const c of extras.cast ?? []) {
    out.push(`RECURRING: ${c.name} (${DESK_LABEL[c.desk]}), mentioned ${c.mentions}× before.`);
  }
  // A headline alone does not stop the model rewriting the same paragraph
  // under a new one, so the opening of each story rides along too.
  for (const p of rotateWindow(extras.previously ?? [], 6, rotate).shown) {
    out.push(`PREVIOUSLY: ${p}`);
  }
  return out;
}

/**
 * Last price seen for a commodity at a station, keyed "station|commodity".
 *
 * The market snapshot the app keeps is the CURRENT board — record() overwrites
 * per market, so yesterday's number is gone. A price with nothing to compare it
 * to is a listing, not news; this is the thin slice of history that turns
 * "Steel is 3,456" into "Steel is up 8% since Tuesday".
 */
export type PriceMemory = Record<string, { price: number; at: string }>;

const priceKey = (station: string, commodity: string): string =>
  `${station}|${commodity}`.toLowerCase();

/** Report-worthy movement in a system's markets, and the memory to keep. */
export function marketPulse(
  markets: readonly MarketRecord[],
  previous: PriceMemory = {},
  opts: { maxLines?: number; nowMs?: number } = {},
): { lines: string[]; next: PriceMemory } {
  const next: PriceMemory = { ...previous };
  const moves: Array<{ line: string; weight: number }> = [];
  const byCommodity = new Map<string, Array<{ station: string; buy: number }>>();
  const demand: Array<{ line: string; weight: number }> = [];

  for (const m of markets) {
    for (const item of m.items) {
      const key = priceKey(m.station, item.name);
      if (item.buy > 0 && item.stock > 0) {
        const seen = previous[key];
        if (seen && seen.price > 0 && seen.at !== m.at) {
          const delta = (item.buy - seen.price) / seen.price;
          // A percent either way is noise on a market board, not a story.
          if (Math.abs(delta) >= 0.05) {
            const dir = delta > 0 ? 'up' : 'down';
            moves.push({
              line: `MOVE: ${item.name} at ${m.station} is ${item.buy.toLocaleString('en-US')} cr, ${dir} ${Math.abs(
                Math.round(delta * 100),
              )}% since it was last read.`,
              weight: Math.abs(delta),
            });
          }
        }
        next[key] = { price: item.buy, at: m.at };
        const at = byCommodity.get(item.name);
        if (at) at.push({ station: m.station, buy: item.buy });
        else byCommodity.set(item.name, [{ station: m.station, buy: item.buy }]);
      }
      // What a station is short of is the other half of a market report.
      if (item.sell > 0 && item.demand > 1000) {
        demand.push({
          line: `DEMAND: ${m.station} is paying ${item.sell.toLocaleString('en-US')} cr for ${item.name}, wanting ${item.demand.toLocaleString('en-US')} t.`,
          weight: item.demand,
        });
      }
    }
  }

  const spreads: Array<{ line: string; weight: number }> = [];
  for (const [name, rows] of byCommodity) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((a, b) => a.buy - b.buy);
    const low = sorted[0];
    const high = sorted[sorted.length - 1];
    const gap = high.buy - low.buy;
    if (gap <= 0 || gap / low.buy < 0.08) continue;
    spreads.push({
      line: `SPREAD: ${name} runs ${low.buy.toLocaleString('en-US')} cr at ${low.station} to ${high.buy.toLocaleString(
        'en-US',
      )} cr at ${high.station} — ${gap.toLocaleString('en-US')} cr apart.`,
      weight: gap,
    });
  }

  const pick = (rows: Array<{ line: string; weight: number }>, n: number): string[] =>
    [...rows].sort((a, b) => b.weight - a.weight).slice(0, n).map((r) => r.line);
  const max = opts.maxLines ?? 6;
  // Movement leads: it is the only one of the three that is actually new.
  const lines = [...pick(moves, 3), ...pick(spreads, 2), ...pick(demand, 2)].slice(0, max);
  return { lines, next };
}

/**
 * The checkable claims in a story: its figures and its proper names.
 *
 * Word overlap is the wrong instrument for a wire. The model rewords freely —
 * two civic stories about the identical faction board scored 26% on words,
 * under the duplicate threshold, while citing the same four factions and the
 * same four percentages. What repeats is never the prose; it is the FACTS.
 *
 * Bare capitalised words are skipped ("The", "Meanwhile" — sentence starts,
 * not claims); a name has to be a multi-word run to count.
 */
export function storyFacts(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?%?/g)) out.add(m[0].replace(/,/g, '').toLowerCase());
  for (const m of text.matchAll(nameRun())) {
    const name = m[0].trim();
    if (/\s/.test(name)) out.add(name.toLowerCase());
  }
  return out;
}

/**
 * Has this story already been told, whatever words it uses this time?
 *
 * Containment, not similarity: the question is what fraction of the NEW
 * story's claims were already printed, so a short rewrite of a longer piece is
 * still caught. Stories with barely any facts are exempt — a sport result
 * naming one team should not be spiked for citing that team again.
 */
export function saysNothingNew(
  story: string,
  printed: readonly string[],
  threshold = 0.7,
): boolean {
  const mine = storyFacts(story);
  if (mine.size < 3) return false;
  for (const prior of printed) {
    const theirs = storyFacts(prior);
    if (!theirs.size) continue;
    const shared = [...mine].filter((f) => theirs.has(f)).length;
    if (shared / mine.size >= threshold) return true;
  }
  return false;
}

/** Cast entries worth keeping: the most recently used, capped. */
export function trimCast(cast: readonly CastMember[], max = 12): CastMember[] {
  return [...cast].sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt)).slice(0, max);
}

/**
 * A name shaped like a place the game would own.
 *
 * The paper may invent a darts team; it may not invent a station. Frontier's
 * naming is recognisable — a designation prefix, or a facility suffix — so a
 * new name wearing either is refused rather than quietly canonised.
 */
export function looksLikeGamePlace(name: string): boolean {
  return (
    /\b(HIP|HR|LHS|LTT|LP|Col|Wregoe|Synuefe|Pru|Eol|Byeia|Hyades|Sector)\b/.test(name) ||
    /\b(Terminal|Gateway|Hub|Port|Orbital|Station|Dock|Depot|City|Colony|Outpost|Ring|Prospect|Enterprise|Installation|Beacon|Refinery|Works|Holdings|Vision|Horizons|Landing)\b$/i.test(
      name.trim(),
    )
  );
}

/**
 * A run of capitalised words, the shape a proper name takes.
 *
 * Interior lowercase connectors are part of the name, not a break in it:
 * "Explorer on Tour" is one faction, and a pattern that stops at "on" both
 * fails to whitelist it and cannot recognise it later.
 */
/**
 * Lowercase words that sit INSIDE a proper name ("Explorer on Tour").
 *
 * Deliberately excludes "and": it is how lists are written, not how names are,
 * and including it welded "the Lamplight Rooms and Sal Vance" into a single
 * invented name — two new characters counted as one, and a cast member with a
 * conjunction in the middle of it.
 */
const CONNECTORS = 'of|on|the|de|du|la|le|van|von|del|di|da';
const nameRun = (): RegExp =>
  new RegExp(`[A-Z][\\w'’-]*(?:\\s+(?:${CONNECTORS})\\s+[A-Z0-9][\\w'’-]*|\\s+[A-Z0-9][\\w'’-]*)*`, 'g');

const capsTokens = (name: string): string[] =>
  name
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1 && !new RegExp(`^(?:${CONNECTORS})$`).test(w));

/** Every proper name the paper may print, taken from the brief itself. */
export function allowedNames(brief: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const line of brief) {
    // The label counts too. "LOCAL TRADER:" is the paper's own vocabulary, and
    // stripping it made a story about a local trader read as an invented one.
    for (const m of line.matchAll(nameRun())) {
      const name = m[0].trim();
      if (name.length > 2) out.add(name.toLowerCase());
    }
  }
  return out;
}

/** How the wire is written. The facts do not change; the writer does. */
export type NewsTone = 'straight' | 'wry';

/**
 * The voice, kept apart from the rules on purpose.
 *
 * A wire that only states the board is an almanac with a timestamp — "The
 * Explorer on Tour faction maintains 42.9% influence in the system" is true,
 * accurate, and nobody reads the second sentence. The facts were never the
 * problem; the absence of anyone with an opinion about them was.
 *
 * Separated from NEWS_RULES because a single blob mixing "be funny" with
 * "never fabricate" is how a 4B model starts treating the second one as a
 * suggestion. Both tones inherit the rules verbatim.
 */
const TONE: Readonly<Record<NewsTone, string>> = {
  straight:
    'You write the local news wire for one star system in Elite Dangerous — a small independent ' +
    'outlet on a station concourse feed. Dry, plausible, in-universe.',
  /**
   * A character, not a style guide.
   *
   * Abstract instruction ("be deadpan, be dry, no puns") produced press
   * releases however it was worded, ordered or shortened. A concrete
   * correspondent WITH A HISTORY — four sites still at eighty percent, three
   * collapsed colonisation pushes, twelve revolutionary drives — produced
   * "the machinery moves where the permissions allow" on the first attempt.
   * Give the model somebody to be and the voice follows; give it adjectives
   * and it writes a bulletin.
   *
   * Kept in-universe on purpose. The same persona written for present-day
   * space journalism was funnier still, and filed a story about a Moon colony
   * that does not exist and moved a construction site into another station —
   * the real-world framing dragged real-world facts in with it.
   */
  wry:
    'You are a veteran correspondent on a station concourse news feed in the thirty-fourth ' +
    'century. Dry cynicism, deadpan understatement, awkward honesty — and genuine fascination ' +
    'with the work underneath the sarcasm. ' +
    'You have covered a dozen construction sites, four of which are still at eighty percent; three ' +
    'collapsed colonisation pushes; commanders comparing carrier tonnage; and roughly twelve ' +
    'revolutionary propulsion systems. You respect engineers, dock crews and hauliers, who do the ' +
    'difficult part. You dislike people taking credit for work they do not understand. ' +
    'Separate fact from spin, and never invent a fact because it improves the joke. Prefer the ' +
    'mundane explanation. Report plainly, then note how ridiculous it is that apes who recently ' +
    'invented plumbing are industrialising a star system. ' +
    'An occasional existential aside. Short punchy sentences. Deadpan, not a stream of punchlines. ' +
    'Aim upward — factions, management, anyone with a title — never the crews.',
};

/**
 * Deliberately terse.
 *
 * The first version ran to some seven hundred tokens — rules, worked examples,
 * a list of banned press-office phrases — and every edition came out reading
 * like a press release anyway. The same model, same JSON format, same facts,
 * given only the voice and the bare format, wrote "This means a committee sent
 * a memo about itself. Nothing new here."
 *
 * Length was the problem, not the format. A 4B model spends its instruction
 * budget on whatever there is most of, so there is now less of everything
 * except the voice — which is also why the voice comes last.
 */
const NEWS_RULES =
  'The BRIEF is authoritative: never change a number, and never invent a faction, station, system ' +
  'or commodity. You MAY invent people, teams and bars for the sport and life desks — reuse any ' +
  'RECURRING names rather than inventing rivals for them, and add at most three new names. ' +
  'PREVIOUSLY lines are your own back issues: follow one up, never reprint it. No second person. ' +
  'Reply as a JSON array of {"desk","headline","body"}, desk exactly as given, headline under 60 ' +
  'characters, body one or two sentences under 240. Return only the array.';

/**
 * The same rules, without the JSON.
 *
 * Asking a model for a data structure is asking it for the one thing it is
 * worst at, in exchange for something the code can do for nothing. The desk is
 * chosen here, the count is chosen here, and the edition is assembled here —
 * all the JSON ever carried was a label the caller already knew. Meanwhile it
 * ruled out models outright: Llama 3.1 8B writes livelier prose than the model
 * this app ships and returned `{"civic","Headline"}` — not valid JSON, no keys
 * — so the entire wire fell over on output that read perfectly well.
 *
 * So: one story per call, headline on the first line, body underneath. There is
 * nothing to parse that a blank line does not solve, and every model can do it.
 * The same lesson the comms tier learned when its `[speakerRef]` tags were
 * replaced by plain lines and positional assignment.
 */
const STORY_RULES =
  'The BRIEF is authoritative: never change a number, and never invent a faction, station, system ' +
  'or commodity. You MAY invent people, teams and bars for the sport and life desks — reuse any ' +
  'RECURRING names rather than inventing rivals for them. ' +
  'PREVIOUSLY lines are your own back issues: follow one up, never reprint it. No second person. ' +
  'Write the HEADLINE on the first line, under 60 characters, no label and no quotation marks. ' +
  'Then a blank line. Then the STORY: one or two sentences, under 240 characters. ' +
  'Nothing else — no desk name, no preamble, no markdown, no bullet points.';

const systemPrompt = (tone: NewsTone = 'wry'): string => `${NEWS_RULES}

${TONE[tone] ?? TONE.wry}`;

/** The chat for one edition, one desk per story. */
export function buildNewsChat(
  brief: readonly string[],
  count: number,
  avoid: readonly string[] = [],
  desks: readonly NewsDesk[] = [],
  tone: NewsTone = 'wry',
): Array<{ role: 'system' | 'user'; content: string }> {
  const dodge = avoid.length
    ? `\n\nAlready published — do not repeat these stories or their subjects:\n${avoid
        .slice(-8)
        .map((h) => `- ${h}`)
        .join('\n')}`
    : '';
  const running = (desks.length ? desks : (['civic', 'industry', 'life'] as NewsDesk[])).slice(0, count);
  const orders = running.map((d, i) => `${i + 1}. desk "${d}" — ${DESK_BRIEF[d]}`).join('\n');
  return [
    { role: 'system', content: systemPrompt(tone) },
    {
      role: 'user',
      content:
        `BRIEF:\n${brief.join('\n')}\n\nWrite ${running.length} short stories, one per desk:\n${orders}${dodge}` +
        // The last thing the model reads before it writes. By this point the
        // style paragraph is hundreds of tokens upstream and a small model has
        // quietly reverted to press-release voice.
        (tone === 'wry'
          ? '\n\nHouse style: deadpan, unimpressed, short. You are not writing a press release.'
          : ''),
    },
  ];
}

/** The chat for ONE story on one desk. Prose in, prose out — see STORY_RULES. */
export function buildStoryChat(
  brief: readonly string[],
  desk: NewsDesk,
  avoid: readonly string[] = [],
  tone: NewsTone = 'wry',
  /** Rotates the angle the story is written from — see tone.ts. */
  rotate = 0,
): Array<{ role: 'system' | 'user'; content: string }> {
  const dodge = avoid.length
    ? `\n\nAlready published — do not repeat these or their subjects:\n${avoid
        .slice(-8)
        .map((h) => `- ${h}`)
        .join('\n')}`
    : '';
  return [
    { role: 'system', content: `${STORY_RULES}\n\n${TONE[tone] ?? TONE.wry}` },
    {
      role: 'user',
      content:
        `BRIEF:\n${brief.join('\n')}\n\nWrite one story for the ${DESK_LABEL[desk]} desk — ` +
        `${DESK_BRIEF[desk]}${dodge}` +
        // Last thing read before writing, for the same reason the comms prompt
        // puts its grounding instruction there.
        (tone === 'wry'
          ? '\n\nHouse style: deadpan, unimpressed, short. You are not writing a press release.'
          : '') +
        // The one line that differs between two stories from the same desk on
        // the same brief. Without it the desk remit is identical text every
        // edition, and a desk with one standing fact re-reports it the same way
        // for ever however hot the sampling is.
        `\n\nANGLE: ${newsAngle(rotate)}` +
        '\n\nHeadline on the first line, blank line, then the story.',
    },
  ];
}

/**
 * One story out of plain prose.
 *
 * Forgiving by design, because the failure it replaces was total: a headline
 * line, a blank line, a body. A model that volunteers "Headline:" or wraps
 * things in asterisks is tidied rather than rejected, and one that runs it all
 * together as a single paragraph has its first sentence taken as the headline —
 * which is what a headline is.
 */
export function parseStory(raw: string, desk?: NewsDesk): { headline: string; body: string; desk?: NewsDesk } | null {
  const text = String(raw ?? '')
    .replace(/```[a-z]*/gi, '')
    .replace(/\*\*|__/g, '')
    .trim();
  if (!text) return null;

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*•>]\s*/, '').replace(/^(?:headline|story|body|desk)\s*:\s*/i, ''))
    .filter(Boolean)
    // A whole line of the model reporting on its own homework is not a story.
    .filter((l) => !isModelAside(l));
  if (!lines.length) return null;

  let headline = lines[0];
  let body = lines.slice(1).join(' ').trim();

  // All on one line: the first sentence is the headline, the rest is the story.
  if (!body) {
    const m = /^(.+?[.!?])\s+(.*\S.*)$/.exec(headline);
    if (!m) return null;
    headline = m[1];
    body = m[2];
  }

  headline = clean(stripModelAside(headline)).replace(/[.]+$/, '');
  // The aside usually rides on the END of the body — "(Note: as per your
  // instructions, I've created new people...)" after a perfectly good
  // paragraph. Cut before the whitespace collapse so sentence ends still parse.
  body = clean(stripModelAside(body));
  if (!headline || !body) return null;
  return desk ? { headline, body, desk } : { headline, body };
}

const clean = (s: string): string =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .trim();

/**
 * Pull the stories out of whatever the model returned.
 *
 * Small local models fence JSON in markdown, prefix it with "Here are", or
 * emit one object per line. All three are recoverable and none is worth
 * throwing an edition away over.
 */
export function parseNewsItems(raw: string): Array<{ headline: string; body: string; desk?: NewsDesk }> {
  const text = String(raw ?? '').replace(/```(?:json)?/gi, '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  const out: Array<{ headline: string; body: string; desk?: NewsDesk }> = [];
  const take = (v: unknown): void => {
    const o = v as { headline?: unknown; body?: unknown; title?: unknown; text?: unknown; desk?: unknown };
    const headline = clean((o?.headline ?? o?.title ?? '') as string);
    const body = clean((o?.body ?? o?.text ?? '') as string);
    const raw = clean((o?.desk ?? '') as string).toLowerCase();
    const desk = (Object.keys(DESK_LABEL) as NewsDesk[]).find((d) => d === raw);
    if (headline && body) out.push(desk ? { headline, body, desk } : { headline, body });
  };
  if (start >= 0 && end > start) {
    try {
      const arr = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (Array.isArray(arr)) for (const v of arr) take(v);
    } catch {
      /* fall through to the per-object scan */
    }
  }
  if (!out.length) {
    for (const m of text.matchAll(/\{[^{}]*\}/g)) {
      try {
        take(JSON.parse(m[0]));
      } catch {
        /* not an object after all */
      }
    }
  }
  return out;
}

/**
 * Is this written as a Title Cased Headline rather than a sentence?
 *
 * Judged on the words that carry capitals: headline style capitalises most of
 * them, a sentence capitalises the first and any proper nouns.
 */
export function isTitleCase(line: string): boolean {
  const words = line.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  // Two, not three. A live edition lost "Construction Progress" — a headline
  // about a construction site the brief names — because at two words it fell
  // below the old floor, was read as prose, and its capitalised pair was
  // reported as an invented organisation. Short headlines are the house style
  // here ("A Quiet Week", "Lifts Fail Again"), so the floor was spiking exactly
  // the ones the tone asks for. A two-word invention still gets caught in the
  // body, which is where a story that has one always repeats it.
  if (words.length < 2) return false;
  const caps = words.filter((w) => /^[A-Z]/.test(w)).length;
  return caps / words.length > 0.6;
}

/**
 * EVERY name the paper printed that the brief does not know.
 *
 * Returning only the first was the bug that broke the paper's continuity: a
 * sport story names two teams, the first got registered as canon and the
 * second was never seen, so next edition the model invented a fresh pair. Four
 * editions produced six different teams for one dock-crew league.
 */
export function findInventions(item: { headline: string; body: string }, allowed: Set<string>): string[] {
  const text = isTitleCase(item.headline) ? item.body : `${item.headline}. ${item.body}`;
  const words = new Set<string>();
  for (const a of allowed) for (const w of capsTokens(a)) words.add(w);
  const out: string[] = [];
  for (const m of text.matchAll(nameRun())) {
    const name = m[0].trim();
    const low = name.toLowerCase();
    if (!/\s/.test(name)) continue;
    if (allowed.has(low)) continue;
    if ([...allowed].some((a) => a.includes(low) || low.includes(a))) continue;
    if (capsTokens(name).every((w) => words.has(w))) continue;
    // "The Meridian Hawks" in the body and "Meridian Hawks" in the headline are
    // one team. Registered with the article attached they become two cast
    // members, and neither matches the other next edition — which is how the
    // league ended up with six teams. The article is not part of the name.
    const bare = name.replace(/^(?:The|A|An)\s+/i, '');
    const keep = /\s/.test(bare) ? bare : name;
    if (!out.includes(keep)) out.push(keep);
  }
  return out;
}

/** The first name the paper printed that was not in the brief, or null. */
export function findInvention(item: { headline: string; body: string }, allowed: Set<string>): string | null {
  return findInventions(item, allowed)[0] ?? null;
}

/**
 * Turn a model reply into publishable items.
 *
 * Drops anything that invents a name, repeats a headline already on the wire,
 * or comes back empty. Returning fewer stories than asked for is fine; the
 * wire is allowed to be thin.
 */
export function acceptNews(
  /**
   * A raw model reply to parse, or stories already parsed.
   *
   * The array form is how the per-story prose path feeds this: the desk is
   * known by the caller and the text has already been split, so there is
   * nothing left to guess at. Every check below — inventions, invented places,
   * the name budget, headline and body duplication, cast registration — runs
   * identically either way, which is the point of taking both.
   */
  raw: string | ReadonlyArray<{ headline: string; body: string; desk?: NewsDesk }>,
  opts: {
    brief: readonly string[];
    system: string;
    at: string;
    recentHeadlines?: readonly string[];
    /**
     * Stories already on the wire, in full.
     *
     * The headline check alone let the same story run twice: "Influence shifts
     * remain predictable, if tedious" and "Power structures remain predictably
     * cumbersome" share 11% of their words, while the bodies underneath — the
     * same four factions, the same four percentages — share 35%. A desk with
     * one standing fact will re-report it for ever unless the BODY is checked.
     */
    published?: ReadonlyArray<{ headline: string; body: string }>;
    max?: number;
    /** Desks handed to the model, used when a story does not name its own. */
    desks?: readonly NewsDesk[];
    /** The paper's standing cast — these names are already canon. */
    cast?: readonly CastMember[];
    /** How many brand-new invented names this edition may introduce. */
    newNameBudget?: number;
  },
): { items: NewsItem[]; rejected: string[]; cast: CastMember[] } {
  const allowed = allowedNames(opts.brief);
  const cast = trimCast(opts.cast ?? []);
  for (const c of cast) allowed.add(c.name.toLowerCase());
  const byName = new Map(cast.map((c) => [c.name.toLowerCase(), c]));
  const recent = [...(opts.recentHeadlines ?? []), ...(opts.published ?? []).map((p) => p.headline)];
  // Full text of everything already printed here, for the body comparison.
  const printed = (opts.published ?? []).map((p) => `${p.headline}. ${p.body}`);
  const desks = opts.desks ?? [];
  const items: NewsItem[] = [];
  const rejected: string[] = [];
  // Two, because one fixture has two teams in it.
  // Three: a fixture has two teams and the report quotes somebody, which is
  // three names in one paragraph and an entirely reasonable thing to print.
  // Two cost a fifth of the stories in a live run. trimCast is the real cap.
  let budget = opts.newNameBudget ?? 3;

  const parsed = typeof raw === 'string' ? parseNewsItems(raw) : raw;
  for (const it of parsed) {
    if (items.length >= (opts.max ?? 3)) break;
    // Unlabelled falls back to civic — a REPORTED desk. Defaulting to an
    // invented one would mean a story nobody assigned a desk to gets a licence
    // to make up a faction, which is the opposite of the safe direction.
    const desk = it.desk ?? desks[items.length] ?? 'civic';
    // Sport and life exist to be invented; the reported desks do not.
    const mayInvent = INVENTS.has(desk);
    // ALL of them, not just the first — an unregistered second name is a team
    // the paper forgets it has, and reinvents next week under another name.
    const invented = findInventions(it, allowed);
    const place = invented.find(looksLikeGamePlace);
    if (invented.length && !mayInvent) {
      rejected.push(`invented "${invented[0]}" on the ${desk} desk`);
      continue;
    }
    if (place) {
      rejected.push(`invented a place, "${place}"`);
      continue;
    }
    if (invented.length > budget) {
      rejected.push(`too many new names this edition (${invented.map((n) => `"${n}"`).join(', ')})`);
      continue;
    }
    for (const name of invented) {
      // Canon from here on: registered, whitelisted, and offered back to the
      // model next edition so the dock league keeps the same two teams.
      budget -= 1;
      allowed.add(name.toLowerCase());
      byName.set(name.toLowerCase(), { name, desk, firstAt: opts.at, lastAt: opts.at, mentions: 1 });
    }
    const full = `${it.headline}. ${it.body}`;
    if (isNearDuplicate(it.headline, recent) || isNearDuplicate(full, printed)) {
      rejected.push(`repeat of "${it.headline}"`);
      continue;
    }
    // Different words, same claims. This is the one that catches a desk with a
    // standing fact rewriting it every edition.
    if (saysNothingNew(full, printed)) {
      rejected.push(`nothing new in "${it.headline}"`);
      continue;
    }
    // Anyone from the cast named in this story has been seen again.
    const text = `${it.headline} ${it.body}`.toLowerCase();
    for (const [key, member] of byName) {
      if (member.firstAt === opts.at || !text.includes(key)) continue;
      byName.set(key, { ...member, lastAt: opts.at, mentions: member.mentions + 1 });
    }
    recent.push(it.headline);
    printed.push(full);
    items.push({ headline: it.headline, body: it.body, at: opts.at, system: opts.system, desk });
  }
  return { items, rejected, cast: trimCast([...byName.values()]) };
}

/**
 * Token budget for one edition — reasoning included.
 *
 * Two lessons are baked into this number.
 *
 * llmQuick, the helper the store reaches for, defaults to EIGHT tokens: right
 * for the one-word beat gate it was written for, catastrophic here. At 8 the
 * model returns "```json\n[\n  {" and stops.
 *
 * And the model THINKS before it writes, which is wanted — reasoning is free
 * on a local engine and the stories are better for it. But hidden reasoning
 * spends the same budget as the answer: an edition was measured burning ~700
 * tokens on thinking, leaving nothing for the JSON and returning empty content
 * that read, from the outside, like a model with nothing to say. So the budget
 * has to cover the thinking AND the stories, not just the stories.
 */
export function newsMaxTokens(perEdition: number): number {
  const stories = 220 * Math.max(1, perEdition);
  // Headroom for the reasoning pass. Costs nothing when the model does not use
  // it — max_tokens is a ceiling, not a target.
  return stories + 1200;
}

/** Is the wire due another edition? */
export function newsDue(lastAtMs: number | null, everyMin: number, nowMs: number): boolean {
  if (everyMin <= 0) return false;
  if (lastAtMs == null) return true;
  return nowMs - lastAtMs >= everyMin * 60_000;
}
