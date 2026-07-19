/**
 * Operator — turns mission state into human/spoken guidance.
 *
 * Two layers:
 *  - Deterministic rule-based text (always available; used by tests & offline).
 *  - LLM prompt builders (system prompt per category + a context payload) for
 *    richer on-demand analysis via LM Studio.
 * See SPEC.md §3.2.4, §3.5.
 */
import type { ChatMessage } from './lmstudio.ts';
import type { Mission, MissionCategory, OperatorState } from './types.ts';

export function formatCredits(n: number): string {
  return `${n.toLocaleString('en-US')} cr`;
}

export function minutesBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return (b - a) / 60000;
}

export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes)) return 'unknown';
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/** Minutes until a mission expires, relative to `nowIso`. */
export function minutesToExpiry(m: Mission, nowIso: string): number {
  return m.expiry ? minutesBetween(nowIso, m.expiry) : Number.POSITIVE_INFINITY;
}

function destLabel(m: Mission): string {
  const d = m.destination;
  if (!d) return 'an unknown destination';
  return d.station ? `${d.station} in ${d.system}` : d.system;
}

/** One-line human description of a mission. */
export function describeMission(m: Mission): string {
  const bits: string[] = [`${m.category}`];
  bits.push(`"${m.title}"`);
  if (m.category === 'Assassinate' && m.target) bits.push(`target ${m.target.name} (${m.target.type})`);
  if ((m.category === 'PassengerBulk' || m.category === 'PassengerVIP') && m.passengers)
    bits.push(`${m.passengers.count} ${m.passengers.type}${m.passengers.vip ? ' VIP' : ''}`);
  if (m.commodity) bits.push(`${m.commodity.count} ${m.commodity.localised}`);
  bits.push(`→ ${destLabel(m)}`);
  bits.push(formatCredits(m.reward));
  return bits.join(' · ');
}

// ---------------------------------------------------------------------------
// Event-driven proactive messages (rule-based, deterministic)
// ---------------------------------------------------------------------------

export function briefing(m: Mission, nowIso: string): string {
  const exp = minutesToExpiry(m, nowIso);
  const expText = Number.isFinite(exp) ? `, expires in ${formatDuration(exp)}` : '';
  // VIP passengers often demand a gift commodity (no cargo tracking, but the
  // accept event lists it) — forgetting to buy it voids the run.
  const gift =
    m.commodity && !m.cargo
      ? ` Bring ${m.commodity.count} ${m.commodity.localised} for the client.`
      : '';
  return `New ${m.category} mission accepted: ${m.title}. Head to ${destLabel(m)} for ${formatCredits(m.reward)}${expText}.${gift}`;
}

// ---------------------------------------------------------------------------
// Lively acceptance briefings — the operator's voice, not a form letter.
// Deterministic template layer (offline fallback for the LLM path).
// ---------------------------------------------------------------------------

const pickT = <T,>(arr: readonly T[], rng: () => number): T =>
  arr[Math.floor(rng() * arr.length) % arr.length];

/** Personal, spoken acceptance line. Facts stay exact; tone gets alive. */
export function livelyBriefing(
  m: Mission,
  nowIso: string,
  cmdr: string | undefined,
  rng: () => number,
): string {
  const name = cmdr ? `Commander ${cmdr}` : 'Commander';
  const dest = destLabel(m);
  const pay = formatCredits(m.reward);
  const exp = minutesToExpiry(m, nowIso);
  const timer =
    Number.isFinite(exp) && exp < 6 * 60 ? ` Timer's tight — ${formatDuration(exp)}.` : '';
  const gift =
    m.commodity && !m.cargo
      ? ` And don't lift off without ${m.commodity.count} ${m.commodity.localised} for the client.`
      : '';

  let lines: string[];
  switch (m.category) {
    case 'PassengerBulk':
      lines = [
        `${m.passengers?.count ?? 'A load of'} ${m.passengers?.type ?? ''} souls boarding, ${name}. Get them to ${dest} in one piece and ${pay} is ours.${timer}`,
        `Cabins are filling up — ${m.passengers?.count ?? ''} ${m.passengers?.type ?? 'passengers'} bound for ${dest}. Fly smooth, collect ${pay}.${timer}`,
      ];
      break;
    case 'PassengerVIP':
      lines = [
        `VIP aboard, ${name}: "${m.title}". ${pay} says we keep them smiling all the way to ${dest}.${gift}${timer}`,
        `White-glove run: ${m.passengers?.count ?? 'a'} ${m.passengers?.type ?? 'VIP'} party to ${dest} for ${pay}. No interdictions on my watch.${gift}${timer}`,
      ];
      break;
    case 'Sightseeing':
    case 'LongDistanceExpedition':
      lines = [
        `Tourists with a bucket list, ${name} — beacons first, then ${dest}, ${pay} at the end of the scenic route.${timer}`,
      ];
      break;
    case 'Assassinate':
      lines = [
        `Contract's live: ${m.target?.name ?? 'the target'}. Last seen around ${dest}. ${pay} the moment they stop transmitting.${timer}`,
        `Someone wants ${m.target?.name ?? 'a name'} gone badly enough to pay ${pay}, ${name}. Hunting grounds: ${dest}.${timer}`,
      ];
      break;
    case 'Massacre':
      lines = [
        `${m.faction ?? 'The client'} wants ${m.killCount ?? 'some'} ${m.targetType ?? 'ships'} of ${m.targetFaction ?? 'the enemy'} out of the sky in ${m.destination?.system ?? 'the target system'}. ${pay} for the sweep, ${name}.${timer}`,
      ];
      break;
    case 'Mining':
      lines = [
        `Shopping list, ${name}: ${m.commodity ? `${m.commodity.count} ${m.commodity.localised}` : 'ore'} out of the rings. Refinery time — ${pay} waiting at ${dest}.${timer}`,
      ];
      break;
    case 'Delivery':
    case 'DeliveryWing':
    case 'Collect':
    case 'Salvage':
      lines = [
        `Freight run: ${m.commodity ? `${m.commodity.count} ${m.commodity.localised}` : 'cargo'} to ${dest}. ${pay} on the dock, ${name}.${timer}`,
        `${m.faction ?? 'The client'} needs ${m.commodity ? `${m.commodity.count} ${m.commodity.localised}` : 'goods'} moved to ${dest} — ${pay} when it lands.${timer}`,
      ];
      break;
    case 'Courier':
      lines = [
        `Fresh data run, ${name} — ${dest}, ${pay} on handshake. Easy money if the lanes stay quiet.${timer}`,
        `Somebody's secrets need carrying to ${dest}. ${pay}, no questions.${timer}`,
      ];
      break;
    default:
      lines = [`New contract on the board, ${name}: "${m.title}" → ${dest} for ${pay}.${timer}`];
      break;
  }
  return pickT(lines, rng);
}

/** LLM prompt for a personal acceptance briefing (temperature ~0.7). */
export function buildBriefingChat(m: Mission, state: OperatorState): ChatMessage[] {
  const name = state.cmdr ? `Commander ${state.cmdr}` : 'the commander';
  return [
    {
      role: 'system',
      content:
        `You are the personal Mission Operator of ${name} — a seasoned operations officer on a ` +
        'private comm channel: warm, dry, professional frontier tone (the year is 3312, Colonia ' +
        'region, Elite Dangerous). A new mission was just accepted. Deliver a SHORT lively ' +
        'acceptance briefing: two to three spoken sentences. Use ONLY the facts provided — never ' +
        'invent factions, companies, places or people; always include the destination and the ' +
        'pay; mention the time limit if it is under six hours; mention a required gift commodity ' +
        'or WANTED passengers if listed. Address the commander personally. Correct Elite ' +
        'Dangerous terminology; no modern-Earth idioms. No markdown, no preamble.',
    },
    {
      role: 'user',
      content: `${missionContext(m, state)}\n\nDeliver the acceptance briefing now.`,
    },
  ];
}

export function redirectNotice(m: Mission): string {
  if (m.category === 'Assassinate' || m.category === 'Massacre') {
    return `Target eliminated. You're redirected — return to ${destLabel(m)} to collect ${formatCredits(m.reward)}.`;
  }
  return `Objective updated: now head to ${destLabel(m)}.`;
}

export function arrivalNotice(missions: Mission[]): string {
  if (missions.length === 1) {
    return `You've arrived. You can hand in "${missions[0].title}" here for ${formatCredits(missions[0].reward)}.`;
  }
  const total = missions.reduce((s, m) => s + m.reward, 0);
  return `You've arrived. ${missions.length} missions can be handed in here for ${formatCredits(total)} total.`;
}

export function completionNotice(m: Mission): string {
  const base = `Mission complete: ${m.title}. ${formatCredits(m.reward)} paid.`;
  // The commander may deliberately take a materials/rep package — worth a note
  // when it costs real money against the board price.
  if (m.boardReward && m.reward < m.boardReward * 0.95) {
    return `${base} You took a reduced package — ${formatCredits(m.boardReward - m.reward)} under the board price.`;
  }
  return base;
}

export function cargoNotice(m: Mission): string {
  const c = m.cargo;
  if (!c) return '';
  if (c.delivered >= c.total && c.total > 0) return `All ${c.total} units delivered for "${m.title}".`;
  if (c.collected >= c.total && c.total > 0)
    return `Cargo loaded: ${c.collected}/${c.total}. Deliver to ${destLabel(m)}.`;
  return `Cargo progress on "${m.title}": ${c.delivered}/${c.total} delivered.`;
}

// ---------------------------------------------------------------------------
// Rule-based "what should I do?" advice (LLM fallback)
// ---------------------------------------------------------------------------

export function ruleBasedAdvice(m: Mission, nowIso: string): string {
  const exp = minutesToExpiry(m, nowIso);
  const urgency =
    exp < 15 ? ' This is urgent — it expires very soon.' : exp < 45 ? ' Keep an eye on the timer.' : '';
  switch (m.category) {
    case 'Assassinate':
      return `Fly to ${destLabel(m)} and locate ${m.target?.name ?? 'the target'}. Check the Nav Beacon and Resource Extraction Sites; scan ships to find them. After the kill you'll be redirected to hand in.${urgency}`;
    case 'Massacre':
      return `Head to ${destLabel(m)} and destroy ships of ${m.targetFaction ?? 'the target faction'} — Conflict Zones or RES are best. Progress is tracked per kill.${urgency}`;
    case 'Delivery':
    case 'DeliveryWing':
    case 'Collect':
    case 'Salvage':
    case 'Mining':
      return `Make sure you're carrying ${m.commodity ? `${m.commodity.count} ${m.commodity.localised}` : 'the cargo'}, then deliver to ${destLabel(m)}.${urgency}`;
    case 'PassengerBulk':
    case 'PassengerVIP':
    case 'Sightseeing':
    case 'LongDistanceExpedition':
      return `Transport your ${m.passengers?.type ?? ''} passengers to ${destLabel(m)}${m.passengers?.wanted ? ' — they are WANTED, avoid scans' : ''}.${urgency}`;
    case 'Courier':
    default:
      return `Fly to ${destLabel(m)} and hand in for ${formatCredits(m.reward)}.${urgency}`;
  }
}

// ---------------------------------------------------------------------------
// LLM prompt builders
// ---------------------------------------------------------------------------

const CATEGORY_GUIDANCE: Record<MissionCategory, string> = {
  Courier: 'Data courier: jump to the destination system, dock at the named station, hand in at the mission board (Passenger Lounge/Mission Board). No cargo needed.',
  Delivery: 'Delivery: confirm the cargo is aboard (see cargo progress), jump to the destination, dock, hand the goods in via the mission board.',
  DeliveryWing: 'Large wing delivery: likely needs multiple runs or wingmates; deliver loads to the destination and track the depot progress.',
  Collect: 'Collect: buy or source the commodity first (commodity markets), then deliver to the destination station.',
  Salvage: 'Salvage: the goods are recovered from signal sources or wreck sites in the destination system, then handed in.',
  Mining:
    'Mining: fit prospector limpets, collectors and a refinery. Prospect asteroids for the listed ore — ring hotspots concentrate it, motherlode asteroids are jackpots. Refine to the required tonnage (see cargo progress), then deliver to the destination.',
  PassengerBulk: 'Bulk passengers: keep cabins intact, avoid interdictions (submit and boost away if caught), dock at the destination to drop off.',
  PassengerVIP:
    'VIP passengers: some demand a gift commodity (see the Cargo line) — it must be bought BEFORE departing. WANTED passengers: avoid station scans, Silent Running on approach helps. Deliver to the destination.',
  Sightseeing: 'Sightseeing: fly to each tourist beacon in turn — every stop arrives as a redirect; finish back at the hand-in.',
  LongDistanceExpedition: 'Long expedition: plan jump range, fuel scooping (KGB FOAM stars) and route before departing.',
  Massacre:
    'Pirate/faction massacre: kill ships belonging to the TARGET FACTION in the destination system. Best spots: Resource Extraction Sites and the Nav Beacon (Conflict Zones only for war/civil-war massacres). Scan ships to confirm faction before firing. Kills count automatically; when done, return to the mission giver.',
  Assassinate:
    'Assassination: the named target spawns in the DESTINATION system. Procedure: drop at the Nav Beacon and scan it — this reveals the target\'s location; also watch the FSS for a mission signal source bearing the target\'s name. Engage and destroy the target ship (expect them wanted; a kill-warrant scan is optional). After the kill a redirect will name the hand-in station.',
  Rescue: 'Rescue: enter the hazard area, recover/protect as instructed, and extract safely.',
  Other: 'Give concise, practical guidance.',
};

const BASE_SYSTEM =
  'You are the Mission Operator for an Elite Dangerous commander. Give a concrete, ordered plan ' +
  'for the ACTIVE mission using ONLY the facts in the provided context (mission data, steps, ' +
  'detected signals, stations). Name the specific places from the context — never invent ' +
  'stations, systems, or game features, and never tell the pilot to "check the map" or "check ' +
  'nearby systems" when the context already names where to go. If a location is not in the ' +
  'context, say exactly what to scan (Nav Beacon, FSS) to reveal it. Correct ED terminology. ' +
  'The pilot is flying — 2-4 short speakable sentences, no markdown.';

export function systemPromptFor(category: MissionCategory): ChatMessage {
  return { role: 'system', content: `${BASE_SYSTEM} ${CATEGORY_GUIDANCE[category]}` };
}

/**
 * What the journal has revealed about the current system this session —
 * security/faction plus concrete places to go (RES, Nav Beacon, stations).
 * Null when nothing useful is known (e.g. no FSS scan yet).
 */
export function describeSystemIntel(state: OperatorState): string | null {
  const s = state.system;
  if (!s) return null;
  const lines: string[] = [];
  const props: string[] = [];
  if (s.security) props.push(`security: ${s.security}`);
  if (s.allegiance) props.push(s.allegiance);
  if (s.controllingFaction) props.push(`controlled by ${s.controllingFaction}`);
  if (props.length) lines.push(`Current system (${state.location.system}): ${props.join(', ')}`);

  // Fleet carriers (ubiquitous in hub systems like Colonia) must not drown
  // out real stations; their names end in a XXX-XXX registration.
  const isCarrier = (x: { name: string; type?: string }): boolean =>
    /FleetCarrier/i.test(x.type ?? '') || /\b[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(x.name);
  const stationSignals = s.signals.filter((x) => x.isStation);
  const stations = stationSignals.filter((x) => !isCarrier(x)).map((x) => x.name);
  const carriers = stationSignals.filter(isCarrier).length;
  const sites = s.signals.filter((x) => !x.isStation).map((x) => x.name);
  if (sites.length) lines.push(`Signals detected here: ${sites.slice(0, 8).join(' · ')}`);
  if (stations.length || carriers) {
    const parts: string[] = [];
    if (stations.length)
      parts.push(
        `stations: ${stations.slice(0, 6).join(', ')}${stations.length > 6 ? ` (+${stations.length - 6} more)` : ''}`,
      );
    if (carriers) parts.push(`${carriers} fleet carrier${carriers === 1 ? '' : 's'}`);
    lines.push(`Docking here — ${parts.join(' · ')}`);
  }
  return lines.length ? lines.join('\n') : null;
}

/** Build a compact, accurate context string for the LLM from live state. */
export function missionContext(m: Mission, state: OperatorState): string {
  const lines = [
    `Mission (${m.category}): ${m.title}`,
    `Faction: ${m.faction ?? 'unknown'}`,
    `Destination: ${destLabel(m)}`,
    `Reward: ${formatCredits(m.reward)}`,
    `Expiry: ${m.expiry ?? 'none'} (in ${formatDuration(minutesToExpiry(m, state.now))})`,
    `Current location: ${state.location.station ? `${state.location.station}, ` : ''}${state.location.system}${state.docked ? ' (docked)' : ''}`,
  ];
  if (m.target) lines.push(`Target: ${m.target.name} (${m.target.type})`);
  if (m.targetFaction) lines.push(`Target faction: ${m.targetFaction}`);
  if (m.commodity) lines.push(`Cargo: ${m.commodity.count} ${m.commodity.localised}`);
  if (m.cargo) lines.push(`Cargo progress: ${m.cargo.delivered}/${m.cargo.total} delivered`);
  if (m.passengers)
    lines.push(
      `Passengers: ${m.passengers.count} ${m.passengers.type}${m.passengers.vip ? ' VIP' : ''}${m.passengers.wanted ? ' (WANTED)' : ''}`,
    );
  if (m.redirected) lines.push('Note: mission has been redirected — hand-in destination changed.');
  lines.push(`Steps: ${m.steps.map((s) => `${s.done ? '[x]' : '[ ]'} ${s.label}`).join(' ; ')}`);
  // The rest of the board — lets the model reason about combinations
  // (shared destinations, expiry ordering, gift shopping in one stop).
  const others = state.activeMissions.filter((o) => o.id !== m.id);
  if (others.length) {
    lines.push(`Other active missions (${others.length}):`);
    for (const o of others.slice(0, 6)) {
      const extras: string[] = [];
      if (o.commodity) extras.push(`needs ${o.commodity.count} ${o.commodity.localised}`);
      if (o.passengers) extras.push(`${o.passengers.count} ${o.passengers.type}`);
      lines.push(
        `- ${o.category} "${o.title}" → ${destLabel(o)}${extras.length ? ` (${extras.join(', ')})` : ''}, expires in ${formatDuration(minutesToExpiry(o, state.now))}`,
      );
    }
  }
  const intel = describeSystemIntel(state);
  if (intel) lines.push(intel);
  // Spoon-feed hunting spots for kill missions — small local models otherwise
  // fall back to vague "check your map" advice instead of using the intel.
  if ((m.category === 'Assassinate' || m.category === 'Massacre') && !m.redirected) {
    const inDest =
      !!m.destination && m.destination.system.toLowerCase() === state.location.system.toLowerCase();
    const spots = (state.system?.signals ?? [])
      .filter(
        (s) =>
          !s.isStation &&
          (/ResourceExtraction|NavBeacon|Combat/i.test(s.type ?? '') ||
            /resource extraction|nav beacon|conflict/i.test(s.name)),
      )
      .map((s) => s.name);
    if (!inDest) {
      lines.push(`The pilot must first travel to ${destLabel(m)}.`);
    } else if (spots.length) {
      lines.push(
        `Hunting grounds detected in this system: ${spots.join(', ')}. Send the pilot to one of these, starting with the Nav Beacon scan for assassinations.`,
      );
    } else {
      lines.push(
        'No hunting grounds detected yet in this system — advise a Discovery Scanner honk and FSS scan to reveal sites.',
      );
    }
  }
  return lines.join('\n');
}

export function buildChat(m: Mission, state: OperatorState, question: string): ChatMessage[] {
  return [
    systemPromptFor(m.category),
    { role: 'user', content: `${missionContext(m, state)}\n\nCommander asks: ${question}` },
  ];
}
