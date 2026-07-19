/**
 * Heartbeat — proactive assist monitor (SPEC.md §3.4 / §3.5, roadmap "heartbeat").
 *
 * On each tick it inspects the OperatorState and, when the commander is not
 * making progress, emits Nudges. Cooldowns prevent spam; severity escalates as
 * a timer runs down. This is the "if the user is stalled, help them" feature.
 *
 * Ticks are driven by a timer in the real app, or by the journal clock (plus
 * synthetic ticks in gaps) during replay — so stalls between events are caught.
 */
import type { Mission, OperatorState } from './types.ts';
import { formatCredits, formatDuration, minutesBetween, minutesToExpiry } from './operator.ts';

export type NudgeRule = 'expiry' | 'stuck-hunting' | 'idle-docked' | 'idle-space';
export type NudgeSeverity = 'info' | 'warn' | 'urgent';

export interface Nudge {
  rule: NudgeRule;
  severity: NudgeSeverity;
  missionId?: number;
  message: string;
}

export interface HeartbeatConfig {
  idleDockedMin: number;
  idleSpaceMin: number;
  huntMin: number;
  expiryWarnMin: number;
  expiryUrgentMin: number;
  cooldownMin: number;
}

export const DEFAULT_HEARTBEAT: HeartbeatConfig = {
  idleDockedMin: 5,
  idleSpaceMin: 6,
  huntMin: 8,
  expiryWarnMin: 30,
  expiryUrgentMin: 10,
  cooldownMin: 5,
};

const SEV_RANK: Record<NudgeSeverity, number> = { info: 0, warn: 1, urgent: 2 };

function inSystem(m: Mission, state: OperatorState): boolean {
  return (
    !!m.destination &&
    m.destination.system.toLowerCase() === state.location.system.toLowerCase()
  );
}

function atStation(m: Mission, state: OperatorState): boolean {
  const d = m.destination;
  return (
    inSystem(m, state) &&
    (!d?.station || d.station.toLowerCase() === (state.location.station ?? '').toLowerCase())
  );
}

export class Heartbeat {
  private readonly cfg: HeartbeatConfig;
  /** key -> { lastAt(ISO), severity } for cooldown + escalation. */
  private readonly emitted = new Map<string, { lastAt: string; severity: NudgeSeverity }>();

  constructor(cfg: Partial<HeartbeatConfig> = {}) {
    this.cfg = { ...DEFAULT_HEARTBEAT, ...cfg };
  }

  /** Evaluate the state at `now` (defaults to state.now); return due nudges. */
  evaluate(state: OperatorState, now: string = state.now): Nudge[] {
    const idleMin = state.lastActivityAt ? minutesBetween(state.lastActivityAt, now) : 0;
    const candidates: Nudge[] = [];
    let huntingFired = false;

    // 1) Expiry pressure — per mission.
    for (const m of state.activeMissions) {
      const exp = minutesToExpiry(m, now);
      if (exp > this.cfg.expiryWarnMin) continue;
      const severity: NudgeSeverity = exp <= this.cfg.expiryUrgentMin ? 'urgent' : 'warn';
      const here = atStation(m, state);
      const action = here
        ? `Hand in "${m.title}" now`
        : `Get to ${destLabel(m)} for "${m.title}"`;
      candidates.push({
        rule: 'expiry',
        severity,
        missionId: m.id,
        message: `${severity === 'urgent' ? 'URGENT: ' : ''}${action} — it expires in ${formatDuration(exp)}.`,
      });
    }

    // 2) Stuck hunting — in a kill mission's target system without engaging.
    //    Aggregated into ONE nudge: a stacked set of kill missions (common)
    //    must not produce a wall of near-identical messages.
    const hunting = state.activeMissions.filter(
      (m) =>
        (m.category === 'Assassinate' || m.category === 'Massacre') &&
        !m.redirected &&
        m.killProgress === 0 &&
        inSystem(m, state),
    );
    if (hunting.length && idleMin >= this.cfg.huntMin) {
      huntingFired = true;
      const targets = [
        ...new Set(
          hunting.map((m) =>
            m.target?.name ? `${m.target.name} (${m.target.type})` : (m.targetFaction ?? 'the target'),
          ),
        ),
      ];
      const who =
        targets.length > 2 ? `${targets.slice(0, 2).join(', ')} +${targets.length - 2} more` : targets.join(' and ');
      const intro =
        hunting.length > 1
          ? `${hunting.length} kill missions want targets here: ${who}.`
          : `To find ${who},`;
      candidates.push({
        rule: 'stuck-hunting',
        severity: 'warn',
        missionId: hunting[0].id,
        message: `You've been in ${state.location.system} ${formatDuration(idleMin)} without engaging. ${intro} ${huntVenue(state)}`,
      });
    }

    // 3) Idle while docked with hand-ins waiting elsewhere.
    if (state.docked && idleMin >= this.cfg.idleDockedMin) {
      const pending = state.activeMissions.filter((m) => !atStation(m, state) && m.destination);
      if (pending.length) {
        const minExp = Math.min(...pending.map((m) => minutesToExpiry(m, now)));
        const severity: NudgeSeverity =
          minExp < this.cfg.expiryWarnMin ? 'urgent' : minExp < 60 ? 'warn' : 'info';
        candidates.push({
          rule: 'idle-docked',
          severity,
          message: idleDockedMessage(pending, state, idleMin),
        });
      }
    }

    // 4) Idle in space with no jumps (suppressed if a more specific hunt nudge
    //    fired, or if we're already in the priority mission's destination system
    //    — likely on final supercruise approach, which emits no journal events).
    if (!state.docked && !huntingFired && idleMin >= this.cfg.idleSpaceMin && state.activeMissions.length) {
      const focus = priorityMission(state.activeMissions, now);
      if (focus && !inSystem(focus, state)) {
        candidates.push({
          rule: 'idle-space',
          severity: 'info',
          message: `No progress in ${formatDuration(idleMin)}. Your priority is "${focus.title}" → ${destLabel(focus)}. Want a route or help?`,
        });
      }
    }

    return candidates.filter((n) => this.shouldEmit(n, now));
  }

  /** Cooldown + escalation gate. Emit if past cooldown OR severity increased. */
  private shouldEmit(n: Nudge, now: string): boolean {
    const key = `${n.rule}:${n.missionId ?? 'global'}`;
    const prev = this.emitted.get(key);
    const escalated = prev ? SEV_RANK[n.severity] > SEV_RANK[prev.severity] : true;
    const cooledDown = !prev || minutesBetween(prev.lastAt, now) >= this.cfg.cooldownMin;
    if (escalated || cooledDown) {
      this.emitted.set(key, { lastAt: now, severity: n.severity });
      return true;
    }
    return false;
  }
}

function destLabel(m: Mission): string {
  const d = m.destination;
  if (!d) return 'the destination';
  return d.station ? `${d.station} in ${d.system}` : d.system;
}

/** Name real hunting grounds from FSS intel when we have it; else generic. */
function huntVenue(state: OperatorState): string {
  const signals = state.system?.signals ?? [];
  const res = signals.filter(
    (s) => /ResourceExtraction/i.test(s.type ?? '') || /resource extraction/i.test(s.name),
  );
  const nav = signals.some((s) => /NavBeacon/i.test(s.type ?? '') || /nav beacon/i.test(s.name));
  const spots: string[] = [];
  if (res.length)
    spots.push(res.length > 1 ? `${res[0].name} (+${res.length - 1} more RES)` : res[0].name);
  if (nav) spots.push('the Nav Beacon');
  if (spots.length) return `Detected in this system: ${spots.join(' and ')} — drop in and scan ships.`;
  return 'Try the Nav Beacon or a Resource Extraction Site and scan ships.';
}

function priorityMission(missions: Mission[], now: string): Mission | undefined {
  return [...missions].sort((a, b) => minutesToExpiry(a, now) - minutesToExpiry(b, now))[0];
}

function idleDockedMessage(pending: Mission[], state: OperatorState, idleMin: number): string {
  const total = pending.reduce((s, m) => s + m.reward, 0);
  const dests = new Set(pending.map((m) => destLabel(m)));
  const where = dests.size === 1 ? [...dests][0] : `${dests.size} stations`;
  return `You've been docked at ${state.location.station ?? 'this station'} for ${formatDuration(idleMin)}. ${pending.length} mission(s) worth ${formatCredits(total)} are waiting at ${where}. Ready to undock?`;
}
