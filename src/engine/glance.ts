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

export function buildGlanceMessages(dataUri: string, contextLine: string, cmdr?: string): VisionMessage[] {
  return [
    {
      role: 'system',
      content:
        `You are the Mission Operator glancing at ${cmdr ? `Commander ${cmdr}` : 'the commander'}'s screen for a moment. ` +
        'The dark "MISSION OPERATOR" panel overlaid on the screen is YOUR OWN interface — never describe it; ' +
        'report only on the game beneath it. Scene key: cockpit frame with stars/planets/rings beyond the ' +
        'canopy = flying; full-screen orange/blue text panels = station or ship menus; starfield with orbit ' +
        'lines and a spectrum bar = FSS scanner; big map with routes = galaxy map. ' +
        'Report in one short phrase what the commander is doing (activity), e.g. "browsing the galaxy map", ' +
        '"docked, in the station services menu", "supercruising", "mining an asteroid ring", "in combat". ' +
        'Set notable=true ONLY for something the operator should react to RIGHT NOW: visible danger, very low hull or ' +
        'fuel, an interdiction in progress, a destroyed ship, or something truly bizarre. Menus, maps, ordinary ' +
        'supercruise, docking and normal flight are NEVER notable. If the screen is not the game at all, activity is ' +
        '"not in the game" and notable=false. If notable, give ONE short spoken remark; otherwise remark is empty.',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Glance at the screen now. ${contextLine}`.trim() },
        { type: 'image_url', image_url: { url: dataUri } },
      ],
    },
  ];
}

/**
 * Copilot commentary — the richer sibling of the verdict glance. Instead of a
 * silent JSON verdict, the operator SPEAKS about what it sees on screen,
 * grounded in session facts. Probe-validated on gemma-4-e4b: it reads the HUD
 * ("tinkering with ship settings over at Berman Market") and ties it to the
 * mission board. Paced by the store's chatter cooldown, never by the model.
 */
export function buildCommentaryMessages(
  dataUri: string,
  sessionFacts: string,
  cmdr?: string,
): VisionMessage[] {
  const who = cmdr ? `Commander ${cmdr}` : 'the commander';
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
        'the GALAXY MAP. Read visible HUD text for concrete details (contact names, pad ' +
        'numbers, percentages, warnings like IMPACT) and use one or two of them. ' +
        'Two to four spoken sentences, first person, addressed to the commander: what is ' +
        'happening on screen, plus ONE tactically relevant detail if present (hostiles, low ' +
        'fuel, cargo, landing pad). Mention a session fact ONLY when it directly matches what ' +
        'you see — NEVER claim the commander is at a station, base or place the JOURNAL TRUTH ' +
        'line does not put them at. If the screen is not the game, or is black or unreadable, ' +
        `reply with exactly: NOT_IN_GAME. ${GROUNDING_RULES} No markdown, no preamble.`,
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `${sessionFacts ? `Session facts:\n${sessionFacts}\n\n` : ''}Glance at the screen and talk to me about what I'm doing.`,
        },
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
