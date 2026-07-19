/**
 * MissionStateManager — folds journal events into the live mission set and
 * tracks player location (SPEC.md §3.1.2, §3.1.3).
 *
 * `apply()` returns a list of StateChange notifications so the Operator can
 * produce proactive, event-driven guidance.
 */
import type {
  JournalEvent,
  Location,
  Mission,
  OperatorState,
  SystemIntel,
} from './types.ts';
import { detectBgsState, detectCategory } from './detectType.ts';
import { synthesizeSteps } from './steps.ts';

export type StateChangeKind =
  | 'accepted'
  | 'redirected'
  | 'cargo'
  | 'completed'
  | 'failed'
  | 'abandoned'
  | 'arrivedAtDestination'
  | 'kill'
  | 'jump';

export interface StateChange {
  kind: StateChangeKind;
  mission?: Mission;
  detail?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

const CARGO_CATEGORIES = new Set(['Delivery', 'DeliveryWing', 'Collect', 'Salvage', 'Mining']);

/** "$tritium_name;" / "Tritium" / "tritium" → "tritium" (journal naming varies). */
export function normalizeCommodity(s: string): string {
  return s
    .toLowerCase()
    .replace(/^\$/, '')
    .replace(/_name;?$/, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Effect-code fragment → what it affects (journal $MISSIONUTIL_… strings). */
const EFFECT_KIND: Array<[RegExp, string]> = [
  [/_EP_/, 'economy'],
  [/_SP_/, 'security'],
  [/_SL_/, 'standard of living'],
  [/_HE_/, 'health'],
  [/_DL_/, 'development'],
];

/**
 * Compact BGS summary from a MissionCompleted event's FactionEffects, e.g.
 * "Tir Technology Services: economy ↑, influence + · Brian's Thugs: security ↓".
 */
export function bgsSummary(ev: JournalEvent, fallbackFaction?: string): string | null {
  const effects = ev.FactionEffects;
  if (!Array.isArray(effects)) return null;
  const parts: string[] = [];
  for (const entry of effects as Array<Record<string, unknown>>) {
    const name =
      (typeof entry.Faction === 'string' && entry.Faction) || fallbackFaction || 'local faction';
    const bits: string[] = [];
    if (Array.isArray(entry.Effects)) {
      for (const ef of entry.Effects as Array<Record<string, unknown>>) {
        const code = typeof ef.Effect === 'string' ? ef.Effect : '';
        const kind = EFFECT_KIND.find(([re]) => re.test(code))?.[1] ?? 'status';
        const arrow = ef.Trend === 'UpGood' ? '↑' : ef.Trend === 'DownBad' ? '↓' : '·';
        bits.push(`${kind} ${arrow}`);
      }
    }
    if (Array.isArray(entry.Influence) && (entry.Influence as unknown[]).length) {
      const inf = (entry.Influence as Array<Record<string, unknown>>)[0];
      const sign = typeof inf.Influence === 'string' && inf.Influence ? inf.Influence : null;
      if (sign) bits.push(`influence ${sign}`);
    }
    if (typeof entry.Reputation === 'string' && entry.Reputation) {
      bits.push(`reputation ${entry.Reputation}`);
    }
    if (bits.length) parts.push(`${name}: ${bits.join(', ')}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** A live Community Goal as re-stated by the journal's CommunityGoal event. */
export interface CommunityGoal {
  id: number;
  title: string;
  system: string;
  market: string;
  expiry: string | null;
  bonus: number;
  contributors: number;
  playerContribution: number;
  complete: boolean;
}

/** "Mission_Assassinate_Planet_name" → "Assassinate Planet" (placeholder title). */
function humanizeMissionName(name: string): string {
  const words = name
    .replace(/^mission_/i, '')
    .replace(/_name$/i, '')
    .split('_')
    .filter(Boolean);
  return words.length ? words.join(' ') : 'Unknown mission';
}

export class MissionStateManager {
  private missions = new Map<number, Mission>();
  location: Location = { system: 'unknown' };
  docked = false;
  lastActivityAt = '';
  now = '';
  private systemIntel: SystemIntel = { signals: [] };
  /** Live Community Goals (journal CommunityGoal event, re-stated on login). */
  communityGoals: CommunityGoal[] = [];
  commanderName = '';

  /** Missions still in play (ACTIVE or REDIRECTED). */
  activeMissions(): Mission[] {
    return [...this.missions.values()].filter(
      (m) => m.state === 'ACTIVE' || m.state === 'REDIRECTED',
    );
  }

  allMissions(): Mission[] {
    return [...this.missions.values()];
  }

  getState(): OperatorState {
    return {
      now: this.now,
      location: { ...this.location },
      docked: this.docked,
      activeMissions: this.activeMissions(),
      lastActivityAt: this.lastActivityAt,
      system: { ...this.systemIntel, signals: [...this.systemIntel.signals] },
      cmdr: this.commanderName || undefined,
    };
  }

  /** Apply one journal event; return notifications describing what changed. */
  apply(ev: JournalEvent): StateChange[] {
    this.now = ev.timestamp ?? this.now;
    const changes: StateChange[] = [];
    switch (ev.event) {
      case 'MissionAccepted':
        changes.push(...this.onAccepted(ev));
        break;
      case 'MissionRedirected':
        changes.push(...this.onRedirected(ev));
        break;
      case 'CargoDepot':
        changes.push(...this.onCargoDepot(ev));
        break;
      case 'MissionCompleted':
        changes.push(...this.onFinished(ev, 'COMPLETE', 'completed'));
        break;
      case 'MissionFailed':
        changes.push(...this.onFinished(ev, 'FAILED', 'failed'));
        break;
      case 'MissionAbandoned':
        changes.push(...this.onFinished(ev, 'ABANDONED', 'abandoned'));
        break;
      case 'FSDJump':
      case 'CarrierJump':
        changes.push(...this.onJump(ev));
        break;
      case 'Location':
        this.location = { system: str(ev.StarSystem) ?? this.location.system };
        this.docked = ev.Docked === true;
        this.captureSystemIntel(ev, str(ev.StarSystem));
        // Session start / respawn counts as activity — without this the idle
        // clock still runs from the previous session's last event and the
        // heartbeat nags the moment the game comes up.
        this.touch();
        break;
      case 'FSSSignalDiscovered':
        this.onSignal(ev);
        break;
      case 'Docked':
        changes.push(...this.onDocked(ev));
        break;
      case 'Undocked':
        this.docked = false;
        this.location = { system: this.location.system };
        this.touch();
        break;
      case 'Bounty':
      case 'FactionKillBond':
        changes.push(...this.onKill(ev));
        break;
      case 'Missions':
        // The journal re-states the active set at every login — same shape as
        // Missions.json. Vital when the game is closed and the snapshot file
        // has been removed: without this a fresh launch shows zero missions.
        this.reconcile(ev);
        break;
      case 'CommunityGoal':
        this.onCommunityGoal(ev);
        break;
      case 'LoadGame':
      case 'Commander':
        this.commanderName = str(ev.Commander) ?? str(ev.Name) ?? this.commanderName;
        break;
      case 'MiningRefined':
      case 'MarketBuy':
      case 'CollectCargo':
        changes.push(...this.onCargoGain(ev));
        break;
      default:
        break;
    }
    // Recompute steps for surviving active missions against current location.
    for (const m of this.missions.values()) {
      if (m.state === 'ACTIVE' || m.state === 'REDIRECTED') {
        m.steps = synthesizeSteps(m, this.location);
      }
    }
    return changes;
  }

  /**
   * Reconcile against a `Missions.json` snapshot (`event:"Missions"`):
   * refresh live expiry from `Expires` (seconds remaining at snapshot time),
   * create placeholder missions accepted in sessions we did not replay, and
   * drop active missions the game no longer lists. Quiet by design — snapshot
   * corrections should not produce operator chatter.
   */
  reconcile(ev: JournalEvent): void {
    if (ev.event !== 'Missions' || !Array.isArray(ev.Active)) return;
    const snapMs = Date.parse(ev.timestamp);
    if (Number.isNaN(snapMs)) return;
    const seen = new Set<number>();
    for (const entry of ev.Active as Array<Record<string, unknown>>) {
      const id = num(entry.MissionID);
      if (id == null) continue;
      seen.add(id);
      let m = this.missions.get(id);
      if (!m) {
        const name = str(entry.Name) ?? 'Mission_Unknown';
        const category = detectCategory(name);
        m = {
          id,
          internalName: name,
          title: humanizeMissionName(name),
          category,
          bgsState: detectBgsState(name),
          origin: undefined,
          destination: undefined,
          reward: 0,
          wing: false,
          expiry: null,
          acceptedAt: ev.timestamp,
          steps: [],
          state: 'ACTIVE',
          redirected: false,
          killProgress: 0,
          raw: { timestamp: ev.timestamp, event: 'Missions', Name: name, MissionID: id },
        };
        m.steps = synthesizeSteps(m, this.location);
        this.missions.set(id, m);
      }
      const expires = num(entry.Expires);
      if (expires != null && expires > 0) {
        m.expiry = new Date(snapMs + expires * 1000).toISOString();
      }
    }
    // Drop active missions the snapshot no longer lists — but only if the
    // snapshot is not older than what we learned from the journal.
    for (const m of this.missions.values()) {
      if ((m.state === 'ACTIVE' || m.state === 'REDIRECTED') && !seen.has(m.id)) {
        if (snapMs >= Date.parse(m.acceptedAt)) m.state = 'ABANDONED';
      }
    }
  }

  private touch(): void {
    this.lastActivityAt = this.now;
  }

  private onAccepted(ev: JournalEvent): StateChange[] {
    const id = num(ev.MissionID);
    if (id == null) return [];
    const name = str(ev.Name) ?? 'Mission_Unknown';
    const category = detectCategory(name);
    const count = num(ev.Count);
    const mission: Mission = {
      id,
      internalName: name,
      title: str(ev.LocalisedName) ?? name,
      category,
      bgsState: detectBgsState(name),
      faction: str(ev.Faction),
      targetFaction: str(ev.TargetFaction),
      origin: { ...this.location },
      destination: str(ev.DestinationSystem)
        ? { system: str(ev.DestinationSystem)!, station: str(ev.DestinationStation) }
        : undefined,
      reward: num(ev.Reward) ?? 0,
      boardReward: num(ev.Reward) ?? 0,
      influence: str(ev.Influence),
      reputation: str(ev.Reputation),
      wing: ev.Wing === true,
      expiry: str(ev.Expiry) ?? null,
      acceptedAt: ev.timestamp,
      commodity:
        str(ev.Commodity) && count != null
          ? {
              name: str(ev.Commodity)!,
              localised: str(ev.Commodity_Localised) ?? str(ev.Commodity)!,
              count,
            }
          : undefined,
      passengers:
        num(ev.PassengerCount) != null
          ? {
              count: num(ev.PassengerCount)!,
              type: str(ev.PassengerType) ?? 'Passengers',
              vip: ev.PassengerVIPs === true,
              wanted: ev.PassengerWanted === true,
            }
          : undefined,
      target: str(ev.Target)
        ? { name: str(ev.Target)!, type: str(ev.TargetType_Localised) ?? str(ev.TargetType) ?? 'target' }
        : undefined,
      targetType: str(ev.TargetType_Localised),
      killCount: num(ev.KillCount),
      cargo:
        CARGO_CATEGORIES.has(category) && count != null
          ? { collected: 0, delivered: 0, total: count, progress: 0 }
          : undefined,
      steps: [],
      state: 'ACTIVE',
      redirected: false,
      killProgress: 0,
      raw: ev,
    };
    mission.steps = synthesizeSteps(mission, this.location);
    this.missions.set(id, mission);
    this.touch();
    return [{ kind: 'accepted', mission }];
  }

  private onRedirected(ev: JournalEvent): StateChange[] {
    const m = this.missions.get(num(ev.MissionID) ?? -1);
    if (!m) return [];
    const newSys = str(ev.NewDestinationSystem);
    const newStn = str(ev.NewDestinationStation);
    if (newSys) m.destination = { system: newSys, station: newStn || undefined };
    m.redirected = true;
    if (m.state === 'ACTIVE') m.state = 'REDIRECTED';
    if (m.category === 'Massacre') {
      // Redirect = the game confirming the count is complete; snap to it.
      m.killProgress = m.killCount ?? Math.max(m.killProgress, 1);
    } else if (m.category === 'Assassinate') {
      // The kill that triggered this redirect was the NAMED target, not a
      // generic pirate — retract the massacre tick(s) its bounty caused.
      this.retractLastKillTicks(ev.timestamp);
      m.killProgress = Math.max(m.killProgress, 1);
    }
    return [{ kind: 'redirected', mission: m, detail: newStn ?? newSys }];
  }

  /** Bounty ticks from the last kill, so an assassination redirect can undo them. */
  private lastKillTicks: { atMs: number; missionIds: number[] } | null = null;

  private retractLastKillTicks(nowIso: string): void {
    const t = this.lastKillTicks;
    this.lastKillTicks = null;
    if (!t) return;
    const nowMs = Date.parse(nowIso);
    if (Number.isNaN(nowMs) || nowMs - t.atMs > 10_000) return;
    for (const id of t.missionIds) {
      const m = this.missions.get(id);
      if (m) m.killProgress = Math.max(0, m.killProgress - 1);
    }
  }

  /**
   * Estimate cargo acquisition from what the commander actually does:
   * refining ore (Mining), buying at markets (Delivery/Collect), scooping
   * salvage (Salvage/Collect). Units fill matching missions sequentially,
   * oldest first — CargoDepot remains authoritative when it fires.
   */
  private onCargoGain(ev: JournalEvent): StateChange[] {
    let qty = 1;
    let cats: string[];
    switch (ev.event) {
      case 'MiningRefined':
        cats = ['Mining'];
        break;
      case 'MarketBuy':
        qty = num(ev.Count) ?? 1;
        cats = ['Delivery', 'DeliveryWing', 'Collect'];
        break;
      default: // CollectCargo
        cats = ['Salvage', 'Collect'];
        break;
    }
    const name = str(ev.Type_Localised) ?? str(ev.Type);
    if (!name) return [];
    const key = normalizeCommodity(name);
    const changes: StateChange[] = [];
    const candidates = this.activeMissions()
      .filter((m) => cats.includes(m.category) && m.cargo && m.commodity)
      .filter(
        (m) =>
          normalizeCommodity(m.commodity!.localised) === key ||
          normalizeCommodity(m.commodity!.name) === key,
      )
      .sort((a, b) => Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt));
    let remaining = qty;
    for (const m of candidates) {
      if (remaining <= 0) break;
      const c = m.cargo!;
      if (c.collected >= c.total) continue;
      const add = Math.min(remaining, c.total - c.collected);
      c.collected += add;
      c.progress = c.total > 0 ? c.collected / c.total : 0;
      remaining -= add;
      changes.push({ kind: 'cargo', mission: m, detail: 'collected' });
    }
    if (changes.length) this.touch();
    return changes;
  }

  private onCargoDepot(ev: JournalEvent): StateChange[] {
    const m = this.missions.get(num(ev.MissionID) ?? -1);
    if (!m) return [];
    const total = num(ev.TotalItemsToDeliver) ?? m.cargo?.total ?? 0;
    m.cargo = {
      collected: num(ev.ItemsCollected) ?? m.cargo?.collected ?? 0,
      delivered: num(ev.ItemsDelivered) ?? m.cargo?.delivered ?? 0,
      total,
      progress: num(ev.Progress) ?? m.cargo?.progress ?? 0,
    };
    this.touch();
    return [{ kind: 'cargo', mission: m, detail: str(ev.UpdateType) }];
  }

  private onFinished(
    ev: JournalEvent,
    state: Mission['state'],
    kind: StateChange['kind'],
  ): StateChange[] {
    const m = this.missions.get(num(ev.MissionID) ?? -1);
    if (!m) return [];
    m.state = state;
    if (state === 'COMPLETE' && num(ev.Reward) != null) m.reward = num(ev.Reward)!;
    if (state === 'COMPLETE') this.touch();
    // Recompute steps now: the main apply() loop only refreshes active missions,
    // so a finished mission needs its final step states set here.
    m.steps = synthesizeSteps(m, this.location);
    // BGS consequences ride on the completion event; surface them as detail.
    const detail = state === 'COMPLETE' ? (bgsSummary(ev, m.targetFaction) ?? undefined) : undefined;
    return [{ kind, mission: m, detail }];
  }

  private onJump(ev: JournalEvent): StateChange[] {
    this.location = { system: str(ev.StarSystem) ?? this.location.system };
    this.docked = false;
    this.captureSystemIntel(ev, str(ev.StarSystem));
    this.touch();
    return [{ kind: 'jump' }];
  }

  private intelForSystem = '';

  /** Fold FSDJump/Location system properties; reset signals on a new system. */
  private captureSystemIntel(ev: JournalEvent, system: string | undefined): void {
    if (system && system !== this.intelForSystem) {
      this.intelForSystem = system;
      this.systemIntel = { signals: [] };
    }
    const faction = ev.SystemFaction as { Name?: string } | undefined;
    this.systemIntel.security =
      str(ev.SystemSecurity_Localised) ?? str(ev.SystemSecurity) ?? this.systemIntel.security;
    this.systemIntel.allegiance = str(ev.SystemAllegiance) || this.systemIntel.allegiance;
    this.systemIntel.controllingFaction =
      (faction && str(faction.Name)) || this.systemIntel.controllingFaction;
    this.systemIntel.population = num(ev.Population) ?? this.systemIntel.population;
  }

  private onCommunityGoal(ev: JournalEvent): void {
    if (!Array.isArray(ev.CurrentGoals)) return;
    this.communityGoals = (ev.CurrentGoals as Array<Record<string, unknown>>).map((g) => ({
      id: num(g.CGID) ?? 0,
      title: str(g.Title) ?? 'Community Goal',
      system: str(g.SystemName) ?? '?',
      market: str(g.MarketName) ?? '?',
      expiry: str(g.Expiry) ?? null,
      bonus: num(g.Bonus) ?? 0,
      contributors: num(g.NumContributors) ?? 0,
      playerContribution: num(g.PlayerContribution) ?? 0,
      complete: g.IsComplete === true,
    }));
  }

  /** FSSSignalDiscovered → local points of interest (RES, Nav Beacon, stations). */
  private onSignal(ev: JournalEvent): void {
    const raw = str(ev.SignalName) ?? '';
    if (raw.startsWith('$USS')) return; // transient unidentified sources
    const name = str(ev.SignalName_Localised) ?? raw;
    if (!name) return;
    const signals = this.systemIntel.signals;
    if (signals.length >= 40 || signals.some((s) => s.name === name)) return;
    signals.push({
      name,
      type: str(ev.SignalType),
      isStation: ev.IsStation === true,
    });
  }

  private onDocked(ev: JournalEvent): StateChange[] {
    this.location = {
      system: str(ev.StarSystem) ?? this.location.system,
      station: str(ev.StationName),
    };
    this.docked = true;
    this.touch();
    // Proactive hand-in reminder: any active mission whose destination we reached.
    const changes: StateChange[] = [];
    for (const m of this.activeMissions()) {
      const d = m.destination;
      if (
        d &&
        d.system.toLowerCase() === this.location.system.toLowerCase() &&
        (!d.station || d.station.toLowerCase() === (this.location.station ?? '').toLowerCase())
      ) {
        changes.push({ kind: 'arrivedAtDestination', mission: m });
      }
    }
    return changes;
  }

  private onKill(ev: JournalEvent): StateChange[] {
    this.touch();
    const victim = str(ev.VictimFaction);
    if (!victim) return [];
    const changes: StateChange[] = [];
    // ED's stacking rule: one kill counts once per mission GIVER — stacked
    // massacres from the same faction fill SEQUENTIALLY (oldest first), while
    // missions from different givers count in parallel. Assassinate never
    // counts here (its completion arrives as MissionRedirected).
    // Still an estimate: Bounty events don't reveal the ship *type* the
    // mission requires (e.g. Pirates), hence the "est." labelling.
    const tickedIds: number[] = [];
    const claimedGivers = new Set<string>();
    const candidates = [...this.missions.values()]
      .filter(
        (m) =>
          m.state === 'ACTIVE' &&
          m.category === 'Massacre' &&
          !!m.targetFaction &&
          m.targetFaction.toLowerCase() === victim.toLowerCase(),
      )
      .sort((a, b) => Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt));
    for (const m of candidates) {
      const giver = (m.faction ?? '').toLowerCase();
      if (claimedGivers.has(giver)) continue;
      if (m.killCount != null && m.killProgress >= m.killCount) continue; // full → next in chain
      m.killProgress += 1;
      claimedGivers.add(giver);
      tickedIds.push(m.id);
      changes.push({ kind: 'kill', mission: m });
    }
    const atMs = Date.parse(ev.timestamp);
    this.lastKillTicks = tickedIds.length && !Number.isNaN(atMs) ? { atMs, missionIds: tickedIds } : null;
    return changes;
  }
}
