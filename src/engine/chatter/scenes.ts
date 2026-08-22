/**
 * A transmission is a scene, not a line.
 *
 * The reference implementation ships both shapes, which makes the comparison
 * unusually clean. Its ChitChat file is one-liners:
 *
 *     The star patterns in <starsystem> suggest a stable region.
 *
 * and its SpaceChatter file is exchanges:
 *
 *     [<ship1>] <callsign> to <stationname>, requesting docking clearance.
 *     [<stationname>] Acknowledged, <callsign>. Proceed to pad 12.
 *
 * The second reads as an inhabited world and the first reads as a quote
 * generator, and the difference is not writing quality — it is that a call and
 * a response imply two people who exist independently of the commander. So the
 * unit here is 1..4 turns, and anything with more than one turn must use more
 * than one speaker.
 *
 * On top of that, every scene declares what it is DOING dramatically. The
 * reference has exactly one function — texture — which is why however good its
 * individual lines are, nothing ever builds. A scene that establishes can be
 * complicated later and reversed later still, by the same voice, and that is
 * what turns ambience into a world.
 */
import type { Brief } from './brief.ts';
import type { ChannelId, DramaticFunction } from './types.ts';

export const MIN_TURNS = 1;
export const MAX_TURNS = 4;

/** One line of a scene, before a persona has been cast onto it. */
export interface SceneTurn {
  /**
   * WHO says it, as a role reference rather than a name — 'control', 'hauler',
   * 'crew:engineering'. The cast resolves it to a persona and a name, so the
   * same template can be spoken by a stranger in one system and by a regular
   * in another.
   */
  speakerRef: string;
  text: string;
}

export interface Scene {
  id: string;
  channel: ChannelId;
  func: DramaticFunction;
  turns: SceneTurn[];
  brief: Brief;
  /** How long this stays worth saying. */
  ttlMs: number;
  /** The arc this belongs to, when it is part of a running thread. */
  arcId?: string;
  /** Which tier produced it — the verifier only runs on 'llm'. */
  tier: 'grammar' | 'llm';
  /**
   * Which template produced it, as `CHANNEL:line`.
   *
   * The identity a LISTENER uses. Two renderings of one template differ by a
   * ship name and are two distinct strings, two cache entries and — to
   * anybody actually flying — the same line said twice. Text comparison
   * cannot see that; this can.
   */
  templateId?: string;
}

export type SceneProblem =
  | 'no-turns'
  | 'too-many-turns'
  | 'one-speaker-many-turns'
  | 'empty-turn'
  | 'unbound-token';

/**
 * Structural check. Returns the problem, or null when the scene is well formed.
 *
 * `unbound-token` is the one that matters most: a template whose token never
 * resolved would otherwise be spoken with literal angle brackets in it, which
 * is the single most immersion-destroying thing this feature could do.
 */
export function validateScene(scene: Scene): SceneProblem | null {
  if (scene.turns.length < MIN_TURNS) return 'no-turns';
  if (scene.turns.length > MAX_TURNS) return 'too-many-turns';
  if (scene.turns.some((t) => !t.text.trim())) return 'empty-turn';
  if (scene.turns.some((t) => /<[A-Za-z_][A-Za-z0-9_]*>/.test(t.text))) return 'unbound-token';
  if (scene.turns.length > 1) {
    const speakers = new Set(scene.turns.map((t) => t.speakerRef));
    if (speakers.size < 2) return 'one-speaker-many-turns';
  }
  return null;
}

/** The whole scene as one string — for anti-repetition and the log. */
export function sceneText(scene: Scene): string {
  return scene.turns.map((t) => t.text).join(' ');
}

/**
 * Which dramatic functions an act will accept.
 *
 * CRISIS accepts nothing: it is defined by removal (design D10). AFTERMATH is
 * the only act that will take an `aftermath` beat, because an aftermath before
 * the thing it follows is just a non sequitur.
 */
export function functionsForAct(
  act: 'QUIET' | 'BUILDING' | 'CRISIS' | 'AFTERMATH',
): readonly DramaticFunction[] {
  switch (act) {
    case 'QUIET':
      // Room to breathe: atmosphere, and the setup that pays off later.
      return ['texture', 'establish'];
    case 'BUILDING':
      // No idle texture while something is winding up — that is the tell.
      return ['establish', 'complicate', 'reverse'];
    case 'CRISIS':
      return [];
    case 'AFTERMATH':
      return ['aftermath', 'reverse', 'texture'];
    default:
      return ['texture'];
  }
}
