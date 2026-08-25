/**
 * The spine, rendered — the same campaign threads in three registers.
 *
 * One formatter, three voices, and the register split IS the fact/fiction
 * boundary: comms gets the full picture and licence lives in its own prompt;
 * news gets the threads plus the lane chatter as attributed material; the
 * operator gets SUBSTRATE ONLY — real events and standings, with anything
 * fictional carried strictly as "heard on comms", because the operator
 * quoting the chatter is factually true (the chatter really went on air) while
 * the operator asserting its content would be a lie a commander could act on.
 *
 * Every line is DATA in the dossier idiom. No imperatives, no rules, no output
 * format — the models fixate on instructions and thrive on facts; structure
 * belongs in code. The contract test pins this.
 */
import type { CampaignView, Payoff, SpineThread, SpineVoice } from './campaign.ts';
import { CLOCK_SEGMENTS } from './campaign.ts';

/** A voice's spine section never exceeds this many lines. */
export const SPINE_LINES_MAX = 6;

/** The clock, spoken as pressure rather than pips — data, in words. A clock
 *  at zero WITH a cooldown standing is not calm, it is the morning after: the
 *  scenario sim caught "comes to a head" and "the pressure has eased" riding
 *  the same prompt, which is a contradiction a small model will chew on. */
function clockPhrase(t: SpineThread): string {
  if (t.clock <= 0) {
    return t.cooldownUntil ? 'the dust is still settling' : 'the pressure has eased for now';
  }
  if (t.clock <= 2) return `early rumblings (${t.clock} of ${CLOCK_SEGMENTS})`;
  if (t.clock <= 4) return `pressure building (${t.clock} of ${CLOCK_SEGMENTS})`;
  return `close to breaking (${t.clock} of ${CLOCK_SEGMENTS})`;
}

function roleWord(thread: SpineThread): string {
  return thread.role === 'pursuer'
    ? 'has a grievance with the commander'
    : 'counts the commander a friend';
}

/** The newest real beats, oldest first, as short clauses. */
function recentBeats(thread: SpineThread, n: number): string[] {
  return thread.beats.slice(-n).map((b) => b.text);
}

function threadLineComms(t: SpineThread, hot: boolean): string {
  const beats = recentBeats(t, 2);
  return (
    `ONGOING (${t.role}): ${t.faction} ${roleWord(t)}` +
    (hot ? '' : ` — ${clockPhrase(t)}`) +
    (beats.length ? `; lately: ${beats.join('; ')}` : '')
  );
}

function threadLineNews(t: SpineThread, hot: boolean): string {
  const beats = recentBeats(t, 2);
  return (
    `RUNNING STORY: ${t.faction} ${roleWord(t)}` +
    (hot ? '' : ` — ${clockPhrase(t)}`) +
    (beats.length ? `; on record: ${beats.join('; ')}` : '')
  );
}

function threadLineOperator(t: SpineThread): string {
  const beats = recentBeats(t, 2);
  return (
    `${t.role === 'pursuer' ? 'STANDING TROUBLE' : 'STANDING FRIEND'}: ${t.faction}` +
    (beats.length ? ` — ${beats.join('; ')}` : ` — ${roleWord(t)}`)
  );
}

function payoffLine(p: Payoff): string {
  return `TURNING POINT: the ${p.faction} thread comes to a head — the trigger was ${p.cause}`;
}

/**
 * Render the campaign for one voice: at most SPINE_LINES_MAX data lines, empty
 * array for an empty campaign. `rotate` alternates which thread leads so
 * neither hogs the top slot call after call.
 */
export function spineLines(view: CampaignView, voice: SpineVoice, rotate = 0): string[] {
  const threads = [view.pursuer, view.patron].filter((t): t is SpineThread => t != null);
  if (rotate % 2 === 1) threads.reverse();
  const lines: string[] = [];

  const payoff = view.payoffs[voice];
  if (payoff) lines.push(payoffLine(payoff));

  for (const t of threads) {
    // While THIS voice still owes the payoff beat, the TURNING POINT line
    // carries the thread's state — a clock phrase beside it would either
    // contradict it or say it twice.
    const hot = payoff?.faction === t.faction;
    if (voice === 'comms') lines.push(threadLineComms(t, hot));
    else if (voice === 'news') lines.push(threadLineNews(t, hot));
    else lines.push(threadLineOperator(t));
  }

  // The lane chatter: comms hears its own past lines back (continuity), news
  // treats them as material; both attributed so nothing fictional hardens
  // into fact. The operator carries at most ONE, always attributed.
  const aired = threads.flatMap((t) => t.onAir.slice(0, voice === 'operator' ? 1 : 2));
  const airCap = voice === 'operator' ? 1 : 2;
  for (const line of aired.slice(0, airCap)) {
    lines.push(`heard on comms: "${line.text}"`);
  }

  if (view.vow && voice !== 'news') {
    lines.push(`THE COMMANDER'S STANDING AIM: ${view.vow}`);
  }

  return lines.slice(0, SPINE_LINES_MAX);
}
