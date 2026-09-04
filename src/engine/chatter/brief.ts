/**
 * What a transmission is ALLOWED to assert.
 *
 * This is the module the intelligence value of the whole feature rests on. A
 * haulier grumbling that Bertrandite dropped another 380 credits at Hurston is
 * worth more than any panel — the commander gets actionable trade intel
 * through ambience. But it is worth that only if it is TRUE. One invented
 * price and the player learns, correctly and permanently, that the chatter
 * cannot be trusted, at which point it is decoration and the reference
 * implementation already does decoration better.
 *
 * So nothing is generated freehand. Every scene is built from a Brief: an
 * explicit list of the proper nouns it may name and the figures it may state,
 * each carrying its source. Afterwards the text is checked back against that
 * list, and any scene that reached for something outside it is dropped whole.
 *
 * The asymmetry is deliberate. A false negative costs one line of silence. A
 * false positive costs the feature. So the verifier is tuned to over-reject,
 * and the grammar tier — which binds tokens to brief values by construction
 * and therefore CANNOT say anything the brief does not contain — is what keeps
 * the channel busy.
 */

/** Where a fact came from, so the panel can attribute it. */
export type FactSource =
  | { kind: 'market'; station: string; observedAt: string }
  | { kind: 'faction'; system: string }
  | { kind: 'construction'; site: string }
  | { kind: 'geography'; system: string }
  | { kind: 'event'; at: string }
  /** A fact about a mission the commander has ACCEPTED — the id is the
   *  journal's own handle, so attribution survives redirects and renames.
   *  Never a fact about a station's board: the journal does not record
   *  unaccepted offers, so no such fact can exist. */
  | { kind: 'mission'; missionId: number }
  /** An invented person or place the app has COMMITTED to (see cast.ts).
   *  Invented, but stable — which is why it may be named. */
  | { kind: 'cast' };

export interface BriefNoun {
  value: string;
  source: FactSource;
}

export interface BriefFigure {
  /** The figure as it may be spoken, e.g. "380" or "1,240". */
  value: string;
  source: FactSource;
}

/** What kind of thing this brief is about — drives template selection. */
export type BriefKind =
  | 'market'
  | 'faction'
  | 'construction'
  | 'geography'
  | 'event'
  /** What is aboard THIS ship — passengers and mission cargo. A standing
   *  condition: true continuously while the cabins are full. */
  | 'manifest'
  /** An accepted mission as a working relationship — employer, target,
   *  destination, deadline. Moment-bound: only built when the contract is
   *  live in the current moment (see contractRelevance). */
  | 'contract'
  | 'texture';

/**
 * How stale the underlying observation is.
 *
 * Not decoration: a price the commander saw a week ago must not be spoken as
 * a current price, and beyond a certain age it must not be spoken at all.
 */
export type Freshness = 'fresh' | 'stale' | 'expired';

export const FRESH_MAX_MS = 6 * 3_600_000; // 6 hours — say it plainly
export const STALE_MAX_MS = 7 * 24 * 3_600_000; // a week — say it as hearsay

export function freshnessOf(ageMs: number | undefined): Freshness {
  if (ageMs === undefined) return 'fresh'; // timeless facts (geography)
  if (ageMs <= FRESH_MAX_MS) return 'fresh';
  if (ageMs <= STALE_MAX_MS) return 'stale';
  return 'expired';
}

export interface Brief {
  kind: BriefKind;
  /** Proper nouns this scene may name. Nothing else may appear. */
  nouns: BriefNoun[];
  /** Figures this scene may state. */
  figures: BriefFigure[];
  /** Values available to grammar templates, by token name. */
  tokens: Readonly<Record<string, string>>;
  /** Age of the underlying observation, if it has one. */
  ageMs?: number;
  /**
   * Stable identity of what this brief is ABOUT — "Bertrandite@Hurston Ring".
   * Arcs hang off it, and the same-subject anti-repetition gate compares it.
   */
  subjectKey: string;
  /** One-line summary for the transmission log and arc beats. */
  summary: string;
}

/** A brief that asserts nothing — pure atmosphere, nothing to verify. */
export function textureBrief(
  subjectKey: string,
  tokens: Record<string, string> = {},
): Brief {
  return {
    kind: 'texture',
    nouns: [],
    figures: [],
    tokens,
    subjectKey,
    summary: 'atmosphere',
  };
}

export function isFactual(b: Brief): boolean {
  return b.kind !== 'texture' && (b.nouns.length > 0 || b.figures.length > 0);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Capitalised words that are not claims about the world.
 *
 * The verifier flags capitalised words that are not in the brief, which would
 * otherwise reject perfectly good English: titles, the pronoun "I", radio
 * procedure words, and the days and months. Everything here is a word that
 * asserts nothing checkable — the moment a word could be a faction, a station
 * or a system, it belongs in the brief instead.
 */
const GENERIC_CAPITALS = new Set(
  [
    'I', "I'm", "I've", "I'll", "I'd",
    'Commander', 'Captain', 'Cmdr', 'Sir', 'Maam', "Ma'am",
    'Traffic', 'Control', 'Ops', 'Operations', 'Docking', 'Security', 'Station',
    'Copy', 'Roger', 'Wilco', 'Affirmative', 'Negative', 'Standby', 'Mayday',
    'Acknowledged', 'Understood', 'Confirmed', 'Clear', 'Over', 'Out',
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    'January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December',
    'Thargoid', 'Thargoids', 'Guardian', 'Guardians',
    'Federation', 'Empire', 'Alliance', 'Independent',
    'Yes', 'No', 'Okay', 'OK', 'Well', 'Right', 'Look', 'Listen', 'Hey',
    'And', 'But', 'So', 'The', 'A', 'An', 'That', 'This', 'There', 'They',
    'We', 'You', 'It', 'If', 'When', 'What', 'Who', 'How', 'Why',
  ].map((w) => w.toLowerCase()),
);

/** Words that end a sentence, so the next capital is grammar not a claim. */
const SENTENCE_END = /[.!?]["')\]]?\s+$/;

/**
 * Proper-noun-ish tokens in a piece of text.
 *
 * Capitalised runs are collected as whole phrases ("Hurston Ring") AND as
 * their individual words, because a brief may license the phrase while the
 * generated text uses only part of it, or vice versa. Sentence-initial words
 * are skipped unless they are part of a longer capitalised run — "Bertrandite
 * is down again" would otherwise flag on its first word.
 */
/**
 * Strip surrounding punctuation from a word, the way the extractor does.
 *
 * Shared so the licence side and the extraction side agree. They did not:
 * a brief licensing "Resource Extraction Site [Hazardous]" registered the part
 * "[Hazardous]" WITH its brackets, while extraction produced "Hazardous"
 * without them — so every scene about an extraction site failed verification
 * over a fact the brief had explicitly allowed. Signal names are full of
 * brackets, so this was not an edge case.
 */
export function bareWord(w: string): string {
  return w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’-]+$/gu, '');
}

export function properNouns(text: string): string[] {
  const out: string[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  let atSentenceStart = true;
  let run: string[] = [];
  let runStartedAtSentenceStart = false;

  const flush = (): void => {
    if (!run.length) return;
    const phrase = run.join(' ');
    // A one-word run that opened a sentence is grammar, not a name.
    if (!(run.length === 1 && runStartedAtSentenceStart)) {
      out.push(phrase);
      if (run.length > 1) for (const w of run) out.push(w);
    }
    run = [];
  };

  let brokenByPunctuation = false;
  for (const raw of words) {
    const bare = bareWord(raw);
    const isCap = /^\p{Lu}/u.test(bare);
    // A sentence boundary always ends a run. Without this, "…at Hurston Ring.
    // Third time this month." reads as one four-word name, and the scene is
    // rejected for a place nobody mentioned.
    if (atSentenceStart || brokenByPunctuation) flush();
    if (isCap && bare.length > 1 && !GENERIC_CAPITALS.has(bare.toLowerCase())) {
      if (!run.length) runStartedAtSentenceStart = atSentenceStart;
      run.push(bare);
    } else {
      flush();
    }
    atSentenceStart = SENTENCE_END.test(`${raw} `);
    // Proper-noun phrases have no internal punctuation. Without this,
    // "Kepler Landing, Iron Marlin inbound" reads as a single four-word name
    // that no brief could ever license — and BOTH real names in it get
    // rejected along with the scene. Radio traffic is full of exactly this
    // construction (address, then callsign), so it is not an edge case.
    brokenByPunctuation = /[,;:—–-]["')\]]?$/.test(raw);
  }
  flush();
  return [...new Set(out)];
}

/**
 * Spelled-out numbers the verifier also treats as figures.
 *
 * Extraction by digit alone has an obvious hole: a model writing "nine hundred"
 * instead of "900" states an unbriefed quantity and walks straight past the
 * check. But policing every small number word is worse: a live run dropped
 * "Two signatures just popped up" — a good line, saying nothing checkable —
 * because "two" resolved to a figure nobody had licensed.
 *
 * So the floor sits at TWENTY, plus the multipliers. What actually needs
 * policing is a fabricated price, tonnage or bounty, and those are either
 * digits or built from hundred/thousand/million. Small counts in casual speech
 * ("two signatures", "give me three minutes") assert nothing worth defending
 * against, and treating them as claims silences the tier for no gain.
 */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, thousand: 1000, million: 1_000_000,
};

/**
 * Figures in a piece of text.
 *
 * Normalised by stripping thousands separators so "1,240" and "1240" compare
 * equal — the model will render a briefed number either way and neither is a
 * fabrication. Ordinals and pad numbers are figures too: "pad zero four" is
 * safe because it is words, but "pad 4" is a claim about a real station.
 */
export function figuresIn(text: string): string[] {
  const found = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  const out = found.map(normaliseFigure);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const n = NUMBER_WORDS[word];
    if (n !== undefined) out.push(String(n));
  }
  return [...new Set(out)];
}

export function normaliseFigure(s: string): string {
  const cleaned = s.replace(/,/g, '');
  // Trailing ".0" and the like are the same number.
  const n = Number(cleaned);
  return Number.isFinite(n) ? String(n) : cleaned;
}

export interface VerifyResult {
  ok: boolean;
  /** What tripped it, for the log. Empty when ok. */
  offending: string[];
}

/**
 * Check generated text against its brief.
 *
 * Whole-scene rejection is deliberate. Editing an offending sentence out would
 * leave a scene whose remaining half was written to lead somewhere it no
 * longer goes, and the point of the contract is that it is not negotiable.
 */
export function verifyAgainstBrief(text: string, brief: Brief): VerifyResult {
  const allowedNouns = new Set<string>();
  for (const n of brief.nouns) {
    allowedNouns.add(n.value.toLowerCase());
    // The extractor strips punctuation from every word and rejoins, so
    // "Resource Extraction Site [Hazardous]" reaches it as
    // "Resource Extraction Site Hazardous". Licence that normalised form too,
    // or every scene about an extraction site is dropped over a fact the
    // brief explicitly allowed. Signal names are full of brackets.
    const parts = n.value.split(/\s+/);
    const bareParts = parts.map(bareWord).filter(Boolean);
    if (bareParts.length) allowedNouns.add(bareParts.join(' ').toLowerCase());
    // A brief that licenses "Hurston Ring" licenses saying "Hurston".
    for (const part of parts) {
      if (part.length > 1) allowedNouns.add(part.toLowerCase());
    }
    for (const bare of bareParts) {
      if (bare.length > 1) allowedNouns.add(bare.toLowerCase());
    }
  }
  const allowedFigures = new Set(brief.figures.map((f) => normaliseFigure(f.value)));
  // A licensed NAME licenses the digits inside it. Elite is full of these —
  // "HIP 71462 Council", "LHS 3447", "Col 285 Sector" — and without this the
  // figure check rejected the number that was part of a faction the brief had
  // explicitly allowed, quietly killing a large share of real scenes.
  for (const n of brief.nouns) {
    for (const f of figuresIn(n.value)) allowedFigures.add(f);
  }

  const offending: string[] = [];
  for (const noun of properNouns(text)) {
    if (!allowedNouns.has(noun.toLowerCase())) offending.push(noun);
  }
  for (const fig of figuresIn(text)) {
    if (!allowedFigures.has(fig)) offending.push(fig);
  }
  return { ok: offending.length === 0, offending };
}

/** Merge briefs — a scene may draw on more than one source. */
export function mergeBriefs(primary: Brief, ...rest: Brief[]): Brief {
  const merged: Brief = {
    ...primary,
    nouns: [...primary.nouns],
    figures: [...primary.figures],
    tokens: { ...primary.tokens },
  };
  for (const b of rest) {
    merged.nouns.push(...b.nouns);
    merged.figures.push(...b.figures);
    merged.tokens = { ...b.tokens, ...merged.tokens };
    if (b.ageMs !== undefined) {
      merged.ageMs = merged.ageMs === undefined ? b.ageMs : Math.max(merged.ageMs, b.ageMs);
    }
  }
  return merged;
}
