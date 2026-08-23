/**
 * Per-model tuning, applied automatically.
 *
 * Every model family this app has been benchmarked against needs different
 * handling, and none of it is knowledge a player should be expected to carry:
 *
 *   * gemma-4 wants its reasoning kept, now that there is something to reason
 *     ABOUT. Switching it off was right when a beat was just an event and a
 *     location — it cost 5.1 s and produced worse lines. With the arc, mood,
 *     angle and lore in the prompt it earns its keep: beats that engage with
 *     the actual event went 6/10 -> 8/10, at ~1.5 s rather than 5.1 s.
 *   * GLM-4.6V crashes the AMD Vulkan driver outright when thinking is
 *     disabled through the template — reproduced 3/3, and unfixed by a newer
 *     llama.cpp, -fa off, --cache-reuse 0 or --kv-unified. Capping it at the
 *     SERVER is stable but emits malformed output that reads as a refusal
 *     (6/6 beats lost), so its reasoning is simply left on. It also re-serves
 *     its own last line 8 times out of 8 at ordinary penalties.
 *   * Qwen3.5 burns its whole budget on hidden reasoning when a JSON schema is
 *     attached — 3,000 tokens, 23 s, empty output, every attempt — so its
 *     schema calls must have thinking off too, unlike gemma's.
 *   * Qwen3-VL echoes its previous beat 13 times in 16 at the app's default
 *     penalties, and still 5 in 8 at triple strength.
 *
 * So the app picks. `profileFor` matches on the model id the engine reports
 * and falls back to the conservative gemma-shaped defaults for anything
 * unrecognised — a new model behaves like the one this app is tuned around,
 * rather than like whichever quirk was hardcoded last.
 */

/** How to stop a model burning latency on hidden reasoning. */
export type ThinkingControl =
  /** `chat_template_kwargs: {enable_thinking:false}` on the request. */
  | 'template'
  /** `--reasoning-budget 0` on the server — for models the template kwarg
   *  crashes. Costs a restart to change, so it is a launch flag, not per call. */
  | 'server'
  /** Leave reasoning alone; the model is fast enough or needs it. */
  | 'keep';

export interface Penalties {
  presence: number;
  frequency: number;
}

export interface ModelProfile {
  /** Which family matched, for the settings panel and the logs. */
  family: string;
  thinking: ThinkingControl;
  /** Anti-echo strength for ambient beats. */
  penalties: Penalties;
  /** Firmer hand on a resample — the first attempt already tripped a fence. */
  resamplePenalties: Penalties;
  /** Where hidden reasoning is WANTED, per call path. Stated explicitly rather
   *  than inferred: the three paths genuinely disagree, and which ones differ
   *  changes from family to family. */
  thinkingFor: { chatter: boolean; ask: boolean; json: boolean; comms: boolean };
  /** Something the player should know, shown in Settings. Null when the model
   *  simply works. */
  note: string | null;
}

const GEMMA: ModelProfile = {
  family: 'Gemma 4',
  thinking: 'template',
  penalties: { presence: 0.5, frequency: 0.3 },
  resamplePenalties: { presence: 0.7, frequency: 0.5 },
  // Reasoning is wanted EVERYWHERE, including ambient beats.
  //
  // It was originally switched off for chatter, and correctly so at the time:
  // on a bare beat context it cost 5.1 s a beat and the reasoned lines were
  // worse, opening with the "Looks like" the prompt bans. Both halves of that
  // have since changed. stripFillerTics and a sharper prompt killed the hedging
  // opener (0 of 10 either way now), and the beat carries far more to weigh —
  // a computed arc, a mood, a rotating angle, local lore, the persona. Re-run
  // against the current stack: beats that engage with the actual event rose
  // from 6/10 to 8/10, duplicates and fence flags unchanged, and the cost fell
  // to ~1.5 s because only the first beats think hard.
  //
  // ...but NOT for ambient comms, which is a different job wearing the same
  // word. An operator beat weighs an arc, a mood, a rotating angle and local
  // lore, and reasoning demonstrably improves it. A comms scene is two people
  // saying under twelve words each on a radio channel, and measured against
  // this engine the reasoning is pure cost: 449 output tokens and 4.1 s with it
  // on, 15 tokens and 0.34 s with it off, both accepted 4/4, and the fast lines
  // sat BETTER in register ("That beacon is old junk." against the reasoned
  // "Something is moving near the beacon."). Twelve times the latency for no
  // gain, on a tier that writes ahead into slots and throws away anything that
  // arrives late.
  thinkingFor: { chatter: true, ask: true, json: true, comms: false },
  note: null,
};

const PROFILES: Array<{ match: RegExp; profile: ModelProfile }> = [
  {
    // Measured: 0-1 duplicate beats in 16, 541 ms, tools 4/4, JSON valid.
    match: /gemma[-_ ]?4|gemma-4-e[24]b/i,
    profile: GEMMA,
  },
  {
    match: /glm[-_ ]?4|glm-4-6v|glm.*flash/i,
    profile: {
      family: 'GLM 4.6V',
      // Reasoning is left ON, which is the slow option (~4-7 s a beat against
      // gemma's 0.5 s) and still the only correct one for this family:
      //   * disabling it per-request crashes the AMD Vulkan driver (3/3);
      //   * capping it at the engine (--reasoning-budget 0) is stable 8/8 but
      //     emits malformed output — reasoning_content comes back EMPTY while
      //     `content` holds the beat, a stray "</think>", and then "NO_BEAT",
      //     which the silence verdict reads as a refusal. Measured 6/6 beats
      //     lost that way: a mute operator instead of a crashing one.
      // Left on, the output is clean and the model is stable; it is simply not
      // as quick as the default. That trade is the model's, not the player's.
      thinking: 'keep',
      // 8/8 identical openers at 0.5/0.3; needs the firmest hand of any family.
      penalties: { presence: 1.0, frequency: 0.6 },
      resamplePenalties: { presence: 1.2, frequency: 0.8 },
      thinkingFor: { chatter: true, ask: true, json: true, comms: false },
      note:
        'This model thinks before it speaks, so the operator answers more slowly than with the ' +
        'recommended one — switching that off crashes some graphics drivers, so it is left on. ' +
        'It also repeats itself more than most, so repeated lines are filtered out.',
    },
  },
  {
    match: /qwen3\.5|qwen3-5/i,
    profile: {
      family: 'Qwen 3.5',
      thinking: 'template',
      penalties: { presence: 0.8, frequency: 0.5 },
      resamplePenalties: { presence: 1.0, frequency: 0.6 },
      // Its reasoning eats the entire token budget when a schema is attached:
      // 3,000 tokens, 23 s, empty result, every time. Off on every path.
      thinkingFor: { chatter: false, ask: false, json: false, comms: false },
      note: 'Hidden reasoning is switched off everywhere for this model — with it on, ' +
        'schema-constrained calls (session memory, screen readings) return nothing.',
    },
  },
  {
    match: /qwen3-vl|qwen3vl/i,
    profile: {
      family: 'Qwen 3 VL',
      thinking: 'template',
      // 13/16 duplicates at the defaults; still 5/8 at triple strength.
      penalties: { presence: 1.0, frequency: 0.6 },
      resamplePenalties: { presence: 1.2, frequency: 0.8 },
      thinkingFor: { chatter: true, ask: true, json: true, comms: false },
      note: 'This model tends to repeat its previous line; many beats will be filtered out.',
    },
  },
];

/**
 * The tuned settings for a model id, or the conservative default.
 *
 * `id` is whatever the engine reports — for the bundled engine a full path, for
 * LM Studio a publisher/model key — so matching is on substrings of the whole
 * string rather than an exact name.
 */
export function profileFor(id: string | null | undefined): ModelProfile {
  const s = (id ?? '').toString();
  if (!s) return GEMMA;
  for (const { match, profile } of PROFILES) if (match.test(s)) return profile;
  return GEMMA;
}

/**
 * Should this request carry the "no hidden reasoning" template flag?
 *
 * `kind` is the app's own call classification. The rule that used to be
 * hardcoded — everything except JSON and the ask path — is now the GEMMA
 * profile's opinion, and other families disagree with it.
 */
export function suppressThinkingFor(
  profile: ModelProfile,
  kind: 'chatter' | 'json' | 'ask' | 'comms',
): boolean {
  // Only the template mechanism can suppress per request. 'keep' wants
  // reasoning; 'server' must never be sent this kwarg — that request is
  // exactly what faults the driver.
  if (profile.thinking !== 'template') return false;
  return !profile.thinkingFor[kind];
}

/** The `--reasoning-budget` the engine should launch with, or null to omit it. */
export function reasoningBudgetFor(profile: ModelProfile): number | null {
  return profile.thinking === 'server' ? 0 : null;
}

/**
 * Should the speak/skip gate suppress reasoning?
 *
 * Deliberately NOT the same question as `suppressThinkingFor(p, 'chatter')`.
 * The gate answers one word — SPEAK or SKIP — so reasoning buys it nothing and
 * costs everything: measured at 92 ms with the flag and seconds without, on a
 * call that runs before every beat. It should therefore be suppressed whenever
 * doing so is SAFE, independent of what the spoken beats want.
 *
 * Safe means the template mechanism: a 'keep' family (GLM) faults its driver on
 * this kwarg, and a 'server'-capped one has already been dealt with at launch.
 */
export function suppressThinkingForGate(profile: ModelProfile): boolean {
  return profile.thinking === 'template';
}
