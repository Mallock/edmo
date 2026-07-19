/**
 * Replay driver — feeds journal events through the state manager and heartbeat,
 * inserting synthetic heartbeat ticks during time gaps so stalls between events
 * are detected. Produces a structured timeline of operator output.
 *
 * Used by the replay CLI (scripts/replay.ts) and the integration test.
 */
import type { JournalEvent } from './types.ts';
import { MissionStateManager } from './state.ts';
import { Heartbeat } from './heartbeat.ts';
import type { HeartbeatConfig, Nudge, NudgeRule, NudgeSeverity } from './heartbeat.ts';
import {
  arrivalNotice,
  briefing,
  cargoNotice,
  completionNotice,
  redirectNotice,
} from './operator.ts';

export type ReplayKind =
  | 'briefing'
  | 'redirect'
  | 'arrival'
  | 'complete'
  | 'cargo'
  | 'abandoned'
  | 'failed'
  | 'nudge';

export interface ReplayEntry {
  time: string;
  kind: ReplayKind;
  text: string;
  rule?: NudgeRule;
  severity?: NudgeSeverity;
  missionId?: number;
}

export interface ReplayOptions {
  tickMinutes?: number; // synthetic heartbeat cadence during gaps (default 2)
  heartbeat?: Partial<HeartbeatConfig>;
}

function nudgeEntry(time: string, n: Nudge): ReplayEntry {
  return { time, kind: 'nudge', text: n.message, rule: n.rule, severity: n.severity, missionId: n.missionId };
}

export interface ReplayResult {
  entries: ReplayEntry[];
  state: MissionStateManager;
}

export function runReplay(rawEvents: JournalEvent[], opts: ReplayOptions = {}): ReplayResult {
  const events = [...rawEvents].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const sm = new MissionStateManager();
  const hb = new Heartbeat(opts.heartbeat);
  const entries: ReplayEntry[] = [];
  const tickMs = (opts.tickMinutes ?? 2) * 60000;
  let prevMs: number | null = null;

  const runTicks = (fromMs: number, toMs: number): void => {
    for (let t = fromMs + tickMs; t < toMs; t += tickMs) {
      const iso = new Date(t).toISOString();
      for (const n of hb.evaluate(sm.getState(), iso)) entries.push(nudgeEntry(iso, n));
    }
  };

  for (const ev of events) {
    const tMs = Date.parse(ev.timestamp);
    if (prevMs !== null && Number.isFinite(tMs)) runTicks(prevMs, tMs);

    const changes = sm.apply(ev);
    const now = ev.timestamp;

    const arrivals = changes.filter((c) => c.kind === 'arrivedAtDestination' && c.mission).map((c) => c.mission!);
    if (arrivals.length) entries.push({ time: now, kind: 'arrival', text: arrivalNotice(arrivals) });

    for (const c of changes) {
      if (c.kind === 'accepted' && c.mission)
        entries.push({ time: now, kind: 'briefing', text: briefing(c.mission, now), missionId: c.mission.id });
      else if (c.kind === 'redirected' && c.mission)
        entries.push({ time: now, kind: 'redirect', text: redirectNotice(c.mission), missionId: c.mission.id });
      else if (c.kind === 'completed' && c.mission)
        entries.push({ time: now, kind: 'complete', text: completionNotice(c.mission), missionId: c.mission.id });
      else if (c.kind === 'cargo' && c.mission) {
        const text = cargoNotice(c.mission);
        if (text) entries.push({ time: now, kind: 'cargo', text, missionId: c.mission.id });
      } else if (c.kind === 'abandoned' && c.mission)
        entries.push({ time: now, kind: 'abandoned', text: `Mission abandoned: ${c.mission.title}.`, missionId: c.mission.id });
      else if (c.kind === 'failed' && c.mission)
        entries.push({ time: now, kind: 'failed', text: `Mission FAILED: ${c.mission.title}.`, missionId: c.mission.id });
    }

    // Heartbeat also runs at the event moment.
    for (const n of hb.evaluate(sm.getState(), now)) entries.push(nudgeEntry(now, n));

    if (Number.isFinite(tMs)) prevMs = tMs;
  }

  return { entries, state: sm };
}
