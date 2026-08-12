/**
 * Docking refusals — remembering the doors that are shut.
 *
 * Community market data (EDDN, and so Ardent and Spansh) says what a station
 * sells. It cannot say whether you are allowed in. Fleet carriers are the sharp
 * edge of this: an owner can lock docking to their squadron or friends while
 * their market keeps broadcasting, so a carrier that is useless to you looks
 * exactly like the best price in the region.
 *
 * That is not hypothetical. A commander hauling tritium for a 44-jump carrier
 * route was pointed at G9H-NVZ, flew fifteen light-years, requested docking and
 * got `RestrictedAccess` — the same refusal KBY-LHZ had given them thirteen
 * minutes earlier. Nothing recorded either one, so the next lookup would have
 * recommended the same carrier again.
 *
 * The game states the reason plainly, so the only real work is deciding which
 * refusals will still be true next time. "No free pad" clears in a minute;
 * "the owner has not invited you" does not.
 *
 * Pure module — unit-tested in tests/docking.test.ts.
 */
import type { JournalEvent } from './types.ts';

/** Why the request was refused, in words the commander can act on. */
export const DENIAL_REASONS: Readonly<Record<string, string>> = {
  NoSpace: 'no free pad',
  TooLarge: 'your ship is too large for this pad class',
  Hostile: 'you are hostile to this station',
  Offences: 'you have outstanding offences here',
  Distance: 'you are too far out — get closer and request again',
  ActiveFighter: 'recall your fighter first',
  // The one that was missing, so the operator read the raw enum aloud —
  // "Docking denied — RestrictedAccess" — twice in one evening.
  RestrictedAccess: "docking is locked to the owner's squadron or friends",
  DockOffline: 'the docking system there is offline',
  NoReason: 'request denied',
};

/**
 * Refusals still true on a second visit.
 *
 * Deliberately narrow. A transient refusal remembered forever would quietly
 * delete a good station from every future answer, which is a worse failure than
 * the one this fixes: being wrong about a door being shut costs a wasted trip,
 * being wrong about it being open costs the commander a station they could have
 * used. NoSpace/Distance/ActiveFighter are all "try again in a minute".
 */
const DURABLE = new Set(['RestrictedAccess', 'TooLarge', 'Hostile', 'Offences', 'DockOffline']);

export interface Denial {
  station: string;
  system: string;
  reason: string;
  /** ms epoch of the refusal. */
  at: number;
}

/** The refusal in plain words; unknown codes pass through rather than vanish. */
export function explainDenial(reason: string): string {
  return DENIAL_REASONS[reason] ?? (reason ? reason : 'request denied');
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const key = (station: string, system: string): string =>
  `${system.toLowerCase()}|${station.toLowerCase()}`;

export class DockingDenials {
  private denials = new Map<string, Denial>();

  /**
   * Fold a journal event. Returns the denial when it is worth remembering, so
   * the caller can persist and announce it; null for transient refusals and
   * everything else.
   *
   * `DockingDenied` carries no StarSystem, so the caller supplies where they
   * are — a station name alone is not a key (carriers move, names repeat).
   */
  apply(ev: JournalEvent, system: string): Denial | null {
    if (ev.event === 'Docked') {
      // They got in after all — the door is open, whatever it did last time.
      // Without this an owner who opens access stays blacklisted forever.
      const station = str(ev.StationName);
      const sys = str(ev.StarSystem) || system;
      if (station) this.denials.delete(key(station, sys));
      return null;
    }
    if (ev.event !== 'DockingDenied') return null;
    const station = str(ev.StationName);
    const reason = str(ev.Reason);
    if (!station || !DURABLE.has(reason)) return null;
    const denial: Denial = {
      station,
      system: str(ev.StarSystem) || system,
      reason,
      at: Date.parse(ev.timestamp) || Date.now(),
    };
    this.denials.set(key(station, denial.system), denial);
    return denial;
  }

  /** The remembered refusal for a station, or null. */
  deniedAt(station: string, system: string): Denial | null {
    return this.denials.get(key(station, system)) ?? null;
  }

  /** A short marker for a market listing, or null when the door is not shut. */
  note(station: string, system: string): string | null {
    const d = this.deniedAt(station, system);
    return d ? `DOCKING REFUSED HERE — ${explainDenial(d.reason)}` : null;
  }

  all(): Denial[] {
    return [...this.denials.values()].sort((a, b) => b.at - a.at);
  }

  /**
   * One line of operator context, so an answer about where to buy does not
   * cheerfully name a carrier that turned the commander away an hour ago.
   */
  contextLine(): string | null {
    const recent = this.all().slice(0, 4);
    if (!recent.length) return null;
    const list = recent
      .map((d) => `${d.station} (${d.system}) — ${explainDenial(d.reason)}`)
      .join('; ');
    return `Docking has been REFUSED at: ${list}. Do not send them back to these without saying so.`;
  }

  toJSON(): Denial[] {
    return this.all();
  }

  load(rows: unknown): void {
    if (!Array.isArray(rows)) return;
    for (const r of rows as Denial[]) {
      if (r && typeof r.station === 'string' && typeof r.system === 'string') {
        this.denials.set(key(r.station, r.system), r);
      }
    }
  }
}
