/**
 * Step synthesis (SPEC.md §3.1.5).
 *
 * ED does NOT emit a per-mission objective checklist, so we derive one from the
 * mission's category and its current progress signals (CargoDepot, redirect,
 * kill events, completion). Steps are recomputed from mission state; `done`
 * flags come from real progress, not guesses.
 */
import type { Location, Mission, MissionStep } from './types.ts';

function sameSystem(a?: Location, b?: Location): boolean {
  return !!a && !!b && a.system.toLowerCase() === b.system.toLowerCase();
}

function atStation(mission: Mission, loc?: Location): boolean {
  const d = mission.destination;
  if (!d || !loc) return false;
  if (!sameSystem(d, loc)) return false;
  return !d.station || d.station.toLowerCase() === (loc.station ?? '').toLowerCase();
}

const step = (label: string, done: boolean, source: MissionStep['source']): MissionStep => ({
  label,
  done,
  source,
});

/**
 * @param mission current mission
 * @param loc     optional current player location, used to flag travel/dock done
 */
export function synthesizeSteps(mission: Mission, loc?: Location): MissionStep[] {
  const done = mission.state === 'COMPLETE';
  const destSys = mission.destination?.system ?? 'destination';
  const destStn = mission.destination?.station ?? 'the station';
  const arrived = done || sameSystem(mission.destination, loc);
  const docked = done || atStation(mission, loc);

  switch (mission.category) {
    case 'Delivery':
    case 'DeliveryWing':
    case 'Collect':
    case 'Salvage':
    case 'Mining': {
      const c = mission.cargo;
      const cargoLabel = mission.commodity
        ? `${mission.commodity.count} ${mission.commodity.localised}`
        : 'the cargo';
      const collected = done || (c ? c.collected >= c.total && c.total > 0 : false);
      const delivered = done || (c ? c.delivered >= c.total && c.total > 0 : false);
      return [
        step(`Acquire ${cargoLabel}`, collected, 'cargodepot'),
        step(`Travel to ${destSys}`, arrived, 'accept'),
        step(`Deliver at ${destStn}`, delivered, 'cargodepot'),
      ];
    }

    case 'Assassinate':
    case 'Massacre': {
      const need = mission.category === 'Massacre' ? mission.killCount : undefined;
      // Massacre with a known KillCount completes on count (or the redirect the
      // game sends at completion); a single faction kill must NOT check it off.
      const killDone =
        done ||
        mission.redirected ||
        (need != null ? mission.killProgress >= need : mission.killProgress > 0);
      let killLabel: string;
      if (mission.category === 'Massacre' && need != null) {
        const got = Math.min(mission.killProgress, need);
        killLabel = `Eliminate ${need} × ${mission.targetType ?? 'targets'} of ${mission.targetFaction ?? 'the target faction'} (${got}/${need} est.)`;
      } else {
        killLabel = `Eliminate ${
          mission.target?.name ??
          (mission.category === 'Massacre'
            ? `${mission.targetFaction ?? 'the'} targets`
            : 'the target')
        }`;
      }
      const steps: MissionStep[] = [
        step(`Travel to ${destSys}`, killDone || arrived, 'accept'),
        step(killLabel, killDone, 'combat'),
      ];
      // After a kill, ED redirects the hand-in to a (usually different) station.
      if (mission.redirected) {
        steps.push(step(`Return to ${destSys}`, done || arrived, 'redirect'));
        steps.push(step(`Hand in at ${destStn}`, done, 'complete'));
      } else {
        steps.push(step('Return & hand in (after the kill)', done, 'redirect'));
      }
      return steps;
    }

    case 'PassengerBulk':
    case 'PassengerVIP':
    case 'Sightseeing':
    case 'LongDistanceExpedition': {
      const p = mission.passengers;
      const boardLabel = p ? `Board ${p.count} ${p.type} passenger(s)` : 'Board passengers';
      return [
        step(boardLabel, true, 'accept'), // boarded at accept time
        step(`Travel to ${destSys}`, arrived, 'accept'),
        step(`Drop off at ${destStn}`, docked && done ? true : done, 'complete'),
      ];
    }

    case 'Rescue': {
      return [
        step(`Travel to ${destSys}`, arrived, 'accept'),
        step('Recover survivors', done, 'cargodepot'),
        step(`Hand in at ${destStn}`, done, 'complete'),
      ];
    }

    case 'Courier':
    default: {
      return [
        step(`Travel to ${destSys}`, arrived, 'accept'),
        step(`Hand in at ${destStn}`, done, 'complete'),
      ];
    }
  }
}
