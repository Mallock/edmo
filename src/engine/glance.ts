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
