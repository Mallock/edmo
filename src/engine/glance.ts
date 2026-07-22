/**
 * Screen glances — the operator occasionally looks at the commander's screen
 * through the local vision model (all loaded LM Studio gemma-4/qwen3.6 models
 * are VLMs). A glance produces a schema-constrained JSON verdict; the model's
 * `notable` opinion is only ONE input — the store's deterministic gate
 * (interval, cooldown, activity dedupe) owns the final decision to speak, so
 * an over-eager model cannot flood the commander.
 *
 * Privacy: the screenshot is sent ONLY to the configured LM endpoint
 * (default 127.0.0.1) and is never written to disk or kept in memory after
 * the reply arrives. The feature is opt-in (settings.vision.enabled).
 */

import { GROUNDING_RULES, LORE_PRIMER, OPERATOR_VOICE } from './lore.ts';

/** Wire-format chat message that allows OpenAI image content parts. */
export interface VisionMessage {
  role: string;
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
}

export interface GlanceReply {
  activity: string;
  notable: boolean;
  remark: string;
}

// --------------------------------------------------------- screen reading (stage 1)
/**
 * Two-stage vision. Small local VLMs read a busy Elite Dangerous frame AND
 * phrase a grounded copilot line poorly when asked to do both at once — they
 * either hallucinate the scene or narrate the HUD flatly. So we split the job:
 * a first PERCEPTION pass turns the raw screenshot into a compact structured
 * reading (screen type, scenery, verbatim HUD text, hazards), and the operator's
 * SPEAKING pass (commentary/verdict) then works from that reading as text. The
 * describe model only has to look; the operator only has to talk.
 */
export interface SceneDescription {
  /** Coarse screen class — drives how the operator interprets everything else. */
  screen: string;
  /** One plain sentence of the scenery actually visible. */
  view: string;
  /** Selected navigation target name shown by the reticle, or ''. */
  target: string;
  /** Short readable HUD strings, copied verbatim (names, distances, timers…). */
  hudText: string[];
  /** Visible danger cues (hostiles, IMPACT, low fuel gauge…); empty if safe. */
  hazards: string[];
  /** One factual sentence describing the whole screen. */
  summary: string;
}

/** Response_format constraining the stage-1 reading (LM Studio structured output). */
export const SCENE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'scene',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        screen: {
          type: 'string',
          enum: [
            'cockpit-flight',
            'station-menu',
            'fss-scanner',
            'galaxy-map',
            'system-map',
            'on-foot',
            'other',
            'not-game',
          ],
        },
        view: { type: 'string' },
        target: { type: 'string' },
        hud_text: { type: 'array', items: { type: 'string' } },
        hazards: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
      },
      required: ['screen', 'view', 'target', 'hud_text', 'hazards', 'summary'],
    },
  },
};

/** Stage 1: ask the VLM to READ the screen into structured data — no advice,
 *  no story, only what is actually on screen. */
export function buildSceneDescriptionMessages(dataUri: string, cmdr?: string): VisionMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a vision sensor for an Elite Dangerous mission operator. Look at the screenshot and ' +
        'report ONLY what is actually visible, as structured data. Do not give advice, opinions or ' +
        'story, and never invent anything you cannot clearly see. ' +
        'IGNORE the dark "MISSION OPERATOR" overlay panel — that is the operator\'s own HUD, not the ' +
        'game; describe only the Elite Dangerous game beneath it. ' +
        'Classify the screen: cockpit-flight (a cockpit frame with stars, planets, rings or asteroids ' +
        'beyond the canopy), station-menu (a full-screen orange/blue text panel or ship/station menu), ' +
        'fss-scanner (a starfield with orbit lines and a spectrum bar), galaxy-map (a large 3D star map ' +
        'with route lines), system-map, on-foot (first person on foot or in a concourse), other, or ' +
        'not-game (desktop, a video, or anything that is not Elite Dangerous). ' +
        'view: one plain sentence describing the scenery actually visible — e.g. "a ringed gas giant ' +
        'below, dense starfield beyond" or "the orange station-services menu". ' +
        'target: the selected navigation target name shown by the reticle if one is visible, else "". ' +
        'hud_text: copy the SHORT readable strings on the HUD verbatim — target and station names, ' +
        'distances (Ls or km), arrival timers, percentages, contact names, pad numbers, and warning ' +
        'words such as IMPACT, MASS LOCK or OVERHEATING. Omit anything you cannot read clearly. ' +
        'hazards: list any visible danger cues (hostile contacts, IMPACT or heat warnings, shields ' +
        'down, hull damage, a very low fuel gauge); leave it empty when the scene looks safe. ' +
        'summary: one factual sentence describing the whole screen. ' +
        'Report faithfully; if it is not the game, set screen to not-game and leave the rest empty.',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Read ${cmdr ? `Commander ${cmdr}'s` : 'the'} screen and return the scene JSON.` },
        { type: 'image_url', image_url: { url: dataUri } },
      ],
    },
  ];
}

/** Parse the stage-1 reading; null when there is nothing usable (caller then
 *  falls back to handing the raw image straight to the operator). */
export function parseSceneDescription(raw: string): SceneDescription | null {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = /\{[\s\S]*\}/.exec(cleaned);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const strs = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
      : [];
  const scene: SceneDescription = {
    screen: typeof o.screen === 'string' && o.screen.trim() ? o.screen.trim() : 'other',
    view: typeof o.view === 'string' ? o.view.trim() : '',
    target: typeof o.target === 'string' ? o.target.trim() : '',
    hudText: strs(o.hud_text),
    hazards: strs(o.hazards),
    summary: typeof o.summary === 'string' ? o.summary.trim() : '',
  };
  // An empty husk (parsed, but the model saw nothing) is worse than the image
  // itself — signal "unusable" so the caller keeps the direct-image path.
  if (
    scene.screen === 'other' &&
    !scene.view &&
    !scene.target &&
    !scene.summary &&
    scene.hudText.length === 0 &&
    scene.hazards.length === 0
  ) {
    return null;
  }
  return scene;
}

const SCREEN_LABEL: Record<string, string> = {
  'cockpit-flight': 'in the cockpit, flying',
  'station-menu': 'a station or ship menu',
  'fss-scanner': 'the FSS system scanner',
  'galaxy-map': 'the galaxy map',
  'system-map': 'the system map',
  'on-foot': 'on foot',
  other: 'unclear',
  'not-game': 'not the game',
};

/** Render a stage-1 reading into the text block the operator speaks from. */
export function renderSceneForOperator(scene: SceneDescription): string {
  const lines = [
    'SCREEN READING (a first-pass vision scan of the actual screen — concrete detail to draw on, ' +
      'but the JOURNAL TRUTH facts still decide where the commander really is):',
    `- Screen: ${SCREEN_LABEL[scene.screen] ?? scene.screen}`,
  ];
  if (scene.view) lines.push(`- In view: ${scene.view}`);
  if (scene.target) lines.push(`- Selected target on screen: ${scene.target}`);
  if (scene.hudText.length)
    lines.push(`- Readable HUD text: ${scene.hudText.map((t) => `"${t}"`).join(', ')}`);
  lines.push(`- Visible hazards: ${scene.hazards.length ? scene.hazards.join(', ') : 'none apparent'}`);
  if (scene.summary) lines.push(`- Summary: ${scene.summary}`);
  return lines.join('\n');
}

/**
 * Small local VLMs occasionally turn a perfectly healthy fuel reading into
 * generic "keep an eye on the gauge" advice. Telemetry, not pixels, owns that
 * decision. Strip only cautionary fuel sentences while Status.json says fuel
 * is healthy; factual or positive fuel observations can still pass through.
 */
export function suppressUngroundedFuelConcern(
  text: string,
  fuelPct: number | null | undefined,
  lowFuel = false,
): string {
  const clean = text.trim();
  if (!clean || fuelPct == null || fuelPct < 0.25 || lowFuel) return clean;

  const fuelTopic = /\b(?:fuel(?:\s+gauge|\s+reserves?)?|tank|jump capacity|run(?:ning)? dry|scoop(?:ing|able)?|refuel(?:ling|ing)?)\b/i;
  const concern = /\b(?:keep an eye|watch(?:ing)?|monitor(?:ing)?|low|running? dry|run dry|worry|concern|risk|danger|need to|should|must|reserves?|capacity|scoop|refuel)\b/i;
  const sentences = clean.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [clean];
  return sentences
    .filter((sentence) => !(fuelTopic.test(sentence) && concern.test(sentence)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drop the generic coaching and speculation that small local models append
 * to an otherwise useful observation. Real hazard callouts bypass this gate. */
export function suppressRoutineCoaching(text: string, allowSafetyAdvice = false): string {
  const clean = text.trim();
  if (!clean || allowSafetyAdvice) return clean;
  const coaching = /\b(?:keep an eye|maintain (?:this|the|our|your)|watch (?:our|the|your)|make sure|be careful|hold steady|keep it steady|remember to|you (?:need|should|must)|we (?:need|should|must))\b/i;
  const speculation = /\b(?:hopefully|probably|might|could|should be|we(?:'re| are) going to|enough\b.*\bfor (?:a |the )?refit|complications?)\b/i;
  const clauses = clean.match(/[^.!?;]+(?:[.!?;]+|$)/g) ?? [clean];
  return clauses
    .filter((clause) => !coaching.test(clause) && !speculation.test(clause))
    .map((clause) => clause.trim().replace(/;$/, '.'))
    .join(' ')
    .replace(/\?\s+Let(['’])s\b/g, '—let$1s')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Response_format enforcing the glance JSON (LM Studio structured output). */
export const GLANCE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'glance',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        activity: { type: 'string' },
        notable: { type: 'boolean' },
        remark: { type: 'string' },
      },
      required: ['activity', 'notable', 'remark'],
    },
  },
};

export function buildGlanceMessages(
  dataUri: string,
  contextLine: string,
  cmdr?: string,
  scene?: string,
): VisionMessage[] {
  // Stage 2: when a stage-1 reading is supplied the verdict is a TEXT-ONLY
  // call over that reading (much faster, and the model already did the seeing);
  // without one it falls back to reading the raw image directly.
  const userText = scene
    ? `${scene}\n\nJudge the screen from the reading above. ${contextLine}`.trim()
    : `Glance at the screen now. ${contextLine}`.trim();
  return [
    {
      role: 'system',
      content:
        `You are the Mission Operator glancing at ${cmdr ? `Commander ${cmdr}` : 'the commander'}'s screen for a moment. ` +
        'The dark "MISSION OPERATOR" panel overlaid on the screen is YOUR OWN interface — never describe it; ' +
        'report only on the game beneath it. Scene key: cockpit frame with stars/planets/rings beyond the ' +
        'canopy = flying; full-screen orange/blue text panels = station or ship menus; starfield with orbit ' +
        'lines and a spectrum bar = FSS scanner; big map with routes = galaxy map. In a cockpit, an orange ' +
        'target name beside a distance and arrival timer near the reticle means the ship is travelling toward ' +
        'that selected destination. Read the lower-left target panel for its type: OUTPOST, ORBIS, CORIOLIS, ' +
        'OCELLUS or STARPORT means it is a station. Describe this as "in supercruise to [name]" or ' +
        '"approaching [name]", never merely "flying" and never "at" or "docked at" the destination. ' +
        'Report in one short phrase what the commander is doing (activity), e.g. "browsing the galaxy map", ' +
        '"docked, in the station services menu", "supercruising", "mining an asteroid ring", "in combat". ' +
        'Set notable=true ONLY for something the operator should react to RIGHT NOW: visible danger, very low hull or ' +
        'fuel, an interdiction in progress, a destroyed ship, or something truly bizarre. Journal fuel telemetry in ' +
        'the user message is authoritative and overrides the image: fuel is notable only when it is explicitly below ' +
        '25% or marked LOW FUEL. Never infer a fuel problem from jump range, route length or the pictured gauge. ' +
        'Menus, maps, ordinary ' +
        'supercruise, docking and normal flight are NEVER notable. If the screen is not the game at all, activity is ' +
        '"not in the game" and notable=false. If notable, give ONE short spoken remark; otherwise remark is empty.',
    },
    {
      role: 'user',
      content: scene
        ? userText
        : [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
    },
  ];
}

/** The register a commentary beat speaks in — picked by the store from live
 *  context (never repeats the previous one when alternatives exist). */
export type CommentaryAngle = 'view' | 'travel' | 'mission' | 'work';

const ANGLE_INSTRUCTIONS: Record<CommentaryAngle, string> = {
  view:
    'Angle: THE VIEW. Pick one unmistakable feature actually visible beyond the canopy and react ' +
    'to that exact feature. Sound like a crewmate sharing the moment, not a nature documentary. ' +
    'If the view has no specific readable feature, return NO_BEAT.',
  travel:
    'Angle: THE JOURNEY. Connect the selected destination to one useful visible cue such as ETA, ' +
    'distance or arrival state. Make it feel like we are flying this leg together. Do not turn ' +
    'routine travel into fuel advice or generic encouragement.',
  mission:
    'Angle: THE JOB. Connect what is happening now to the real people, cargo or objective aboard ' +
    'and the named destination. Prefer a crisp arrival call followed by one dry line about the ' +
    'mission stake. Use at most two concrete numbers when they are the ETA and mission load. State ' +
    'the mission fact plainly without interpreting it, and never predict complications at hand-in.',
  work:
    'Angle: THE WORK. Quote one specific readable HUD result from the operation in progress—such as ' +
    'a scan result, docking state or mining result—then make one dry crewmate observation. Never ' +
    'invent progress, yield, future work or a task merely because the ship is docked. If no result ' +
    'is readable, return NO_BEAT.',
};

/** Positive cadence beats work better than a wall of prohibitions on small
 * local models. Brackets describe a shape, never facts the model may invent. */
const CADENCE_INSTRUCTIONS: Record<CommentaryAngle, string> = {
  view:
    'Match this cadence: “[specific visible feature]. [brief shared reaction].” Use a concrete ' +
    'visual noun, not a generic claim about beauty, scale or space.',
  travel:
    'Match this cadence: “[target], [ETA or distance]. [brief dry crew reaction grounded in the ' +
    'route or job].” This is a crew call, never an instruction to the pilot.',
  mission:
    'Choose one cadence and STOP when it is complete: “[target], [ETA]. [mission load] behind ' +
    'us—let’s make the arrival boring.” OR “[target] coming up. [mission load] aboard; quiet ' +
    'arrival, clean hand-in.” Replace brackets only with supplied facts. Never add an instruction.',
  work:
    'Match this cadence: “[exact visible HUD result]. [brief dry reaction to only that result].” ' +
    'State what changed, never how the pilot should fly or what the work will yield.',
};

function recentCommentaryBlock(recent: string[]): string {
  const lines = recent.map((s) => s.trim()).filter(Boolean).slice(-3);
  return lines.length
    ? `\n\nRECENT COMMS — do not repeat their topic, image, advice or opening:\n${lines.map((s) => `- ${s}`).join('\n')}`
    : '';
}

/**
 * Copilot commentary — the richer sibling of the verdict glance. Instead of a
 * silent JSON verdict, the operator SPEAKS about what it sees on screen,
 * grounded in session facts and steered by an angle (view/travel/mission/work)
 * so consecutive beats feel like company, not a status readout. Paced by the
 * store's chatter cooldown, never by the model.
 */
export function buildCommentaryMessages(
  dataUri: string,
  sessionFacts: string,
  cmdr?: string,
  angle: CommentaryAngle = 'view',
  recent: string[] = [],
  scene?: string,
): VisionMessage[] {
  const who = cmdr ? `Commander ${cmdr}` : 'the commander';
  // Stage 2: with a stage-1 reading, the operator SPEAKS from that reading as
  // text (no image) — the seeing is already done, so it only has to phrase one
  // grounded beat. Without a reading it falls back to the raw image.
  const userText =
    `${sessionFacts ? `Session facts:\n${sessionFacts}\n\n` : ''}` +
    `${scene ? `${scene}\n\n` : ''}` +
    `${ANGLE_INSTRUCTIONS[angle]}\n${CADENCE_INSTRUCTIONS[angle]}${recentCommentaryBlock(recent)}\n\n` +
    `${scene ? 'Work from the screen reading above.' : 'Glance at the screen.'} Give me one worthwhile comms beat or NO_BEAT.`;
  return [
    {
      role: 'system',
      content:
        `You are the ship's Mission Operator looking over ${who}'s shoulder at the screen. ` +
        `${LORE_PRIMER} ${OPERATOR_VOICE} ` +
        'The dark "MISSION OPERATOR" panel overlaid on the screen is YOUR OWN interface — never ' +
        'describe it or its contents; talk only about the game beneath it. ' +
        'The JOURNAL TRUTH line in the facts states where the commander actually is and whether ' +
        'they are docked or flying — it comes from the game itself and OVERRIDES your visual ' +
        'guess. The screen only adds the scenery and details on top of it. ' +
        'How to read an Elite Dangerous screen: a cockpit frame with stars, planets, rings or ' +
        'asteroids beyond the canopy means the commander is FLYING; a full-screen flat panel of ' +
        'orange/blue text and lists is a STATION MENU or ship panel; a starfield with orbit ' +
        'lines and spectrum bars is the FSS SCANNER (exploration); a large map with routes is ' +
        'the GALAXY MAP. Many separate irregular boulders floating around the ship are an ASTEROID ' +
        'FIELD or RING; one continuous cratered surface spanning the canopy is a nearby MOON or ' +
        'PLANET. Pale ring haze behind solid rocks is not a cloud bank. Read visible HUD text for ' +
        'concrete details (contact names, pad ' +
        'numbers, percentages, warnings like IMPACT) and use one or two of them. A target name ' +
        'with a distance and arrival timer beside the central reticle means the ship is travelling ' +
        'toward that destination. Its lower-left target panel can identify it as an OUTPOST, ORBIS, ' +
        'CORIOLIS, OCELLUS or STARPORT. Call that travelling to or approaching the named station; ' +
        'do not say the commander is already there or docked. ' +
        'Status.json fuel telemetry in the facts is authoritative and overrides the pictured HUD. ' +
        'Only warn about fuel when the facts explicitly say LOW FUEL or give a value below 25%. At ' +
        '25% or above, do not advise watching fuel, jump capacity, reserves, scooping or running dry. ' +
        'Write one natural private-comms beat: one or two short sentences, 35 words maximum. ' +
        'Speak as part of the crew using we, our or us when natural; do not narrate the pilot in ' +
        'third person. Lead with the specific point—never open with "Looks like", "It looks like", ' +
        '"Commander, we have", or "Take a look". Do not recite the HUD, explain routine game ' +
        'mechanics, praise ordinary flying, philosophize about the scale of space, or add unsolicited ' +
        'advice when everything is nominal. Avoid filler such as "keep it steady", "keep an eye", ' +
        '"nice work", "all systems nominal", and "plenty of time". A dry aside is welcome only when ' +
        'it grows directly from a visible fact. Use confident present tense; no rhetorical questions, ' +
        '"hopefully", predictions, or speculation about what passengers feel, what a transfer will ' +
        'be like, or what might happen next. If there is no specific grounded observation worth ' +
        'interrupting the commander for, reply exactly: NO_BEAT. ' +
        'Visible danger (hostiles, IMPACT warnings, ' +
        'very low fuel) always outranks the angle — call it out. ' +
        'Mention a session fact ONLY when it directly matches what ' +
        'you see — NEVER claim the commander is at a station, base or place the JOURNAL TRUTH ' +
        'line does not put them at. If the screen is not the game, or is black or unreadable, ' +
        `reply with exactly: NOT_IN_GAME. ${GROUNDING_RULES} No markdown, no preamble.`,
    },
    {
      role: 'user',
      content: scene
        ? userText
        : [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
    },
  ];
}

/** Parse the model's glance reply; null when unusable. */
export function parseGlanceReply(raw: string): GlanceReply | null {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = /\{[\s\S]*\}/.exec(cleaned);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.activity !== 'string') return null;
  return {
    activity: o.activity.trim(),
    notable: o.notable === true,
    remark: typeof o.remark === 'string' ? o.remark.trim() : '',
  };
}
