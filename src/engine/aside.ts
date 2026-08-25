/**
 * Cut the model's note to the author out of the thing it wrote.
 *
 * Small models like to finish a piece by reporting on it. A gossip story came
 * back with a perfectly good paragraph and then:
 *
 *   (Note: As per your instructions, I've created new people for the gossip
 *   section, while reusing recurring names from previous briefs. The story is
 *   entirely fictional and not based on any actual events or facts.)
 *
 * Every word of that is addressed to whoever wrote the prompt, and none of it
 * belongs on a news wire in the year 3311. Telling the model not to do it is the
 * wrong lever — the prompt already says "nothing else", and the same instinct
 * that adds a compliance note is the one that ignores an instruction not to.
 * So it is cut here, where the rule is exact and testable.
 *
 * The test for an aside is that it talks about the WRITING rather than the
 * world: first person about the task, a direct address to "your instructions",
 * or a disclaimer that the fiction is fiction. Prose about the actual system
 * never does any of those, which is what keeps this from eating real text.
 */

/** Phrases that only appear when the model is talking about its own homework. */
const ASIDE = new RegExp(
  [
    'as (?:per|requested in|instructed)',
    'your (?:instructions?|request|brief|prompt)',
    "(?:i have|i've|i)\\s+(?:created|written|used|reused|kept|invented|avoided|included|made sure)",
    'entirely fictional',
    '(?:not|nothing) based on (?:any )?(?:actual|real)',
    'this (?:story|piece|article|report) is (?:a )?(?:fiction|fictional|invented)',
    'purely fictional',
    'as (?:a|an) (?:ai|assistant|language model)',
    'let me know if',
    'hope (?:this|that) helps',
  ].join('|'),
  'i',
);

/** A trailing bracketed block: "(Note: ...)" or "[Note: ...]". */
const TRAILING_BRACKET = /\s*[([][^()[\]]*[)\]]\s*$/;

/** A trailing sentence opened like an editor's note. */
const TRAILING_NOTE = /(?:^|\s)(?:note|disclaimer|nb|caveat|reminder)\s*[:—-]\s*[^]*$/i;

/**
 * Remove a model's aside from the end of a piece of prose.
 *
 * Only ever cuts from the END, and only when what it cuts is recognisably about
 * the task. A note in the middle of a paragraph is left alone: that is far more
 * likely to be a real parenthetical than a stray confession.
 */
export function stripModelAside(text: string): string {
  let s = String(text ?? '').trim();
  if (!s) return '';

  // Peel trailing bracketed blocks while they read as asides — a model that
  // adds one sometimes adds two.
  for (let i = 0; i < 3; i++) {
    const m = TRAILING_BRACKET.exec(s);
    if (!m || !ASIDE.test(m[0])) break;
    s = s.slice(0, m.index).trim();
  }

  // A bare "Note: ..." tail, unbracketed.
  const note = TRAILING_NOTE.exec(s);
  if (note && ASIDE.test(note[0])) s = s.slice(0, note.index).trim();

  // A final sentence that is about the writing rather than the world. Split on
  // sentence ends so a legitimate closing line is never taken with it.
  const parts = s.split(/(?<=[.!?])\s+/);
  while (parts.length > 1 && ASIDE.test(parts[parts.length - 1])) parts.pop();
  s = parts.join(' ').trim();

  return s.replace(/[\s—-]+$/, '').trim();
}

/** Ways a line announces itself as a note rather than as prose. */
const OPENER =
  /^(?:note|disclaimer|nb|caveat|reminder)\s*[:—-]|^(?:hope (?:this|that) helps|let me know if|as (?:a|an) (?:ai|assistant|language model)|as per your instructions)/i;

/**
 * Is this line NOTHING BUT an aside?
 *
 * Deliberately much stricter than `stripModelAside`. This one deletes a whole
 * line, so "contains a suspicious phrase" is far too broad a test — the first
 * version of it threw away an entire gossip story because the paragraph HAPPENED
 * to end with a bracketed note, and the line as a whole matched. A line is only
 * an aside when it is wholly bracketed, or opens as an editor's note. Anything
 * else with a note stuck on the end is prose that needs trimming, not deleting,
 * and `stripModelAside` handles that.
 */
export function isModelAside(line: string): boolean {
  const s = String(line ?? '').trim();
  if (!s) return false;
  const wrapped = /^[([][\s\S]*[)\]]$/.test(s);
  const bare = wrapped ? s.slice(1, -1).trim() : s;
  if (OPENER.test(bare)) return true;
  return wrapped && ASIDE.test(bare);
}
