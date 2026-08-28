/**
 * The shared vocabulary of the comms feature.
 *
 * Channels, acts and dramatic functions are referenced by nearly every module
 * under chatter/, and several of them reference each other — the director asks
 * which channels an act allows, the scene picker asks which functions the act
 * allows, the panel renders both. Putting the three enums here keeps that from
 * turning into an import cycle.
 */

/**
 * The channels a transmission can arrive on.
 *
 * Not a taxonomy of content — a taxonomy of WHO IS TALKING and how far away
 * they are, because that is what decides how it sounds and when it is even
 * possible. Content lives in scenes.
 */
export type ChannelId =
  | 'TOWER' // traffic control talking to THIS ship, by name
  | 'STATION' // traffic control and station operations
  | 'LOCAL' // ship-to-ship on the open channel
  | 'CREW' // your own crew, over the intercom
  | 'DEEP' // long-range, degraded, when nothing else is in reach
  | 'EMERGENCY' // distress and priority traffic
  | 'CARRIER' // fleet carrier broadcasts
  | 'CONCOURSE'; // station PA, heard on foot

export const CHANNEL_IDS: readonly ChannelId[] = [
  'TOWER',
  'STATION',
  'LOCAL',
  'CREW',
  'DEEP',
  'EMERGENCY',
  'CARRIER',
  'CONCOURSE',
];

/**
 * What a scene is DOING, dramatically.
 *
 * The reference implementation has one function — texture — and that is why
 * its chatter reads as a quote generator however good the individual lines
 * are. A world feels inhabited when things are set up and then paid off.
 */
export type DramaticFunction =
  | 'establish' // introduces a situation or a person
  | 'complicate' // makes an established thing worse
  | 'reverse' // turns it — the payoff beat
  | 'aftermath' // the world reacting to something that already happened
  | 'texture'; // no arc, no stakes, just an inhabited channel

export const DRAMATIC_FUNCTIONS: readonly DramaticFunction[] = [
  'establish',
  'complicate',
  'reverse',
  'aftermath',
  'texture',
];

/**
 * The act the session is in.
 *
 * The state machine of design.md D10. Its most important state is CRISIS,
 * which is defined by what it REMOVES: the sudden silence of chatter the
 * commander had stopped noticing is the cheapest tension device available and
 * costs nothing to generate.
 */
export type Act = 'QUIET' | 'BUILDING' | 'CRISIS' | 'AFTERMATH';

export const ACTS: readonly Act[] = ['QUIET', 'BUILDING', 'CRISIS', 'AFTERMATH'];

/** Why a channel is not currently able to transmit — shown in the panel. */
export type ClosedReason =
  | 'muted'
  | 'no-ports-in-system'
  | 'out-of-range'
  | 'no-carrier'
  | 'not-on-foot'
  | 'unpopulated'
  | 'no-crew'
  | 'too-soon'
  | 'act-suppressed'
  | 'others-in-range'
  | 'no-verified-brief'
  | 'nothing-to-say';

/** Human wording for the panel's channel strip. */
export const CLOSED_REASON_LABEL: Readonly<Record<ClosedReason, string>> = {
  muted: 'squelched',
  'no-ports-in-system': 'no port in system',
  'out-of-range': 'out of range',
  'no-carrier': 'no carrier present',
  'not-on-foot': 'ship-side',
  unpopulated: 'uninhabited system',
  'no-crew': 'no crew aboard',
  'too-soon': 'holding',
  'act-suppressed': 'channel clear — priority traffic',
  'others-in-range': 'local traffic in range',
  'no-verified-brief': 'nothing to report',
  // The tower's resting state. It is not out of range or squelched — it simply
  // has no reason to call, which is what a tower does almost all the time.
  'nothing-to-say': 'standing by',
};
