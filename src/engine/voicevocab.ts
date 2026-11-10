/**
 * Words the speech recogniser should expect (GitHub issue #2).
 *
 * Voice input runs Whisper's small English model, and on its own it has no
 * reason to prefer "carrier" over "carry her": it was never told this is a
 * commander talking to a ship. Whisper accepts an initial prompt, text it
 * treats as what was said just before the clip, which tilts recognition
 * toward that vocabulary and spelling without forcing any of it.
 *
 * The prompt is the game's own words, then the names that matter right now:
 * the system, the station, the carrier, where the route ends. Proper nouns
 * are what a general model gets wrong most, and the journal already knows
 * how to spell them.
 */

const GAME_WORDS =
  'Commander to ship operator, Elite Dangerous. Fleet carrier, carrier jump, carrier market, ' +
  'tritium, Frame Shift Drive, FSD, supercruise, hyperspace, jump range, neutron star, ' +
  'station, starport, outpost, landing pad, settlement, exobiology, Guardian, Thargoid, ' +
  'Powerplay, bounty, mission, cargo, mining, limpets, Spansh, Inara.';

/** Whisper reads at most half its text context (~224 tokens) of prompt. Stay well inside it. */
export const MAX_PROMPT_CHARS = 600;

const MAX_NAME_CHARS = 60;

/** One name, safe to hand to a command line and worth the room it takes. */
function cleanName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw
    .replace(/[\u0000-\u001f"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name.length > MAX_NAME_CHARS || /^unknown$/i.test(name)) return null;
  return name;
}

/**
 * The prompt for one push-to-talk clip. `names` come in priority order;
 * when the prompt fills up, whatever no longer fits is left out.
 */
export function buildSttPrompt(names: readonly (string | null | undefined)[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  // ' Names: ' + '.' around the list.
  let room = MAX_PROMPT_CHARS - GAME_WORDS.length - ' Names: .'.length;
  for (const raw of names) {
    const name = cleanName(raw);
    if (!name || seen.has(name.toLowerCase())) continue;
    const cost = name.length + (kept.length ? 2 : 0);
    if (cost > room) continue;
    seen.add(name.toLowerCase());
    kept.push(name);
    room -= cost;
  }
  return kept.length ? `${GAME_WORDS} Names: ${kept.join(', ')}.` : GAME_WORDS;
}

/** The commander's own extra words, as typed into Settings (comma or line separated). */
export function splitVocabulary(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[,\n]/)
    .map((w) => w.trim())
    .filter(Boolean);
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * True when Whisper handed the prompt back instead of hearing anything. On
 * a near-silent clip a model that was given a prompt can return a run of it
 * as the "transcript", and the operator should not answer its own word list.
 */
export function isPromptEcho(transcript: string, prompt: string): boolean {
  const heard = norm(transcript);
  if (heard.split(' ').length < 4) return false;
  return norm(prompt).includes(heard);
}
