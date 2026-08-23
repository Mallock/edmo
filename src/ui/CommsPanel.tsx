/**
 * The comms panel — what is on the air, and whether you can believe it.
 *
 * Two jobs, and the second is the one that matters.
 *
 * The channel strip shows which channels are live, how well they are coming
 * through, and — when one is shut — WHY. A closed channel that says "no port
 * in system" tells the commander the feature is working; one that just sits
 * there dark reads as broken.
 *
 * The scrollback makes every transmission readable with the audio off, and
 * marks which of them carried reported intelligence. That distinction is the
 * whole point of the grounding contract: a haulier grumbling about a price is
 * worth acting on, and a haulier grumbling about the paperwork is not, and the
 * commander should never have to guess which they just heard.
 */
import type { CommsView } from './store.ts';
import { CLOSED_REASON_LABEL, type ChannelId } from '../engine/chatter/types.ts';

const ago = (atMs: number, nowMs: number): string => {
  const secs = Math.floor((nowMs - atMs) / 1000);
  if (!Number.isFinite(secs) || secs < 5) return 'now';
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h`;
};

/**
 * The reason accounting for the most drops, as a short parenthetical.
 *
 * A bare drop total is not actionable: a writer that cannot reach the model and
 * one whose replies will not parse look identical, and they want opposite fixes.
 */
const dominantDrop = (reasons: Record<string, number>): string => {
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
  return top ? ` (mostly ${top[0]})` : '';
};

const quietLabel = (raw: string): string => {
  switch (raw) {
    case 'not-due':
      return 'holding cadence';
    case 'no-channel':
      return 'no open channel';
    case 'no-material':
      return 'no grounded material';
    case 'nothing-written':
      return 'nothing written ready';
    case 'repetition':
      return 'repetition filtered';
    case 'crisis':
      return 'priority traffic only';
    default:
      return raw;
  }
};

/** Signal strength as five bars — legible at a glance beside a running game. */
function Bars({ strength }: { strength: number }) {
  const lit = Math.max(0, Math.min(5, Math.round(strength * 5)));
  return (
    <span className="comms-bars" title={`signal ${Math.round(strength * 100)}%`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <i key={n} className={n <= lit ? 'on' : 'off'} />
      ))}
    </span>
  );
}

function ChannelRow({
  state,
  muted,
  lastAt,
  nowMs,
  onToggle,
}: {
  state: CommsView['channels'][number];
  muted: boolean;
  lastAt: number | null;
  nowMs: number;
  onToggle: (id: ChannelId) => void;
}) {
  const open = state.open;
  return (
    <li className={`comms-channel${open ? '' : ' closed'}${muted ? ' muted' : ''}`}>
      <button
        type="button"
        className="comms-squelch"
        onClick={() => onToggle(state.id)}
        title={muted ? 'Un-squelch this channel' : 'Squelch this channel'}
        aria-pressed={muted}
      >
        {muted ? '🔇' : '🔈'}
      </button>
      <span className="comms-channel-name">{state.id}</span>
      {open ? (
        <Bars strength={state.strength} />
      ) : (
        <span className="comms-closed-why">{CLOSED_REASON_LABEL[state.reason]}</span>
      )}
      <span className="comms-channel-age">{lastAt ? ago(lastAt, nowMs) : '—'}</span>
    </li>
  );
}

function Entry({
  entry,
  nowMs,
}: {
  entry: CommsView['log'][number];
  nowMs: number;
}) {
  // No fact chips. They annotated each transmission with the fence it was
  // written against, and with the fence gone they had nothing to show but the
  // brief's own subject repeated back — "HIP 71120 — HIP 71120". Comms is
  // overheard radio now: it is allowed to invent, so there is nothing here to
  // vouch for and no honest way to mark some lines as sourced.
  return (
    <li className="comms-entry">
      <div className="comms-entry-head">
        <span className="comms-entry-channel">{entry.channel}</span>
        <span className="comms-entry-age">{ago(entry.at, nowMs)}</span>
      </div>
      {entry.turns.map((turn, i) => (
        <div className="comms-turn" key={i}>
          <span
            className={`comms-speaker${turn.returning ? ' returning' : ''}`}
            title={turn.returning ? 'You have heard this voice before' : undefined}
          >
            {turn.speaker}
            {turn.returning ? ' ↩' : ''}
          </span>
          <span className="comms-line">{turn.text}</span>
        </div>
      ))}
    </li>
  );
}

export function CommsPanel({
  view,
  nowMs,
  onToggleChannel,
}: {
  view: CommsView;
  nowMs: number;
  onToggleChannel: (id: ChannelId) => void;
}) {
  const muted = new Set(view.mutedChannels);
  // CRISIS is the one act defined by what it removes, so say so rather than
  // leaving the commander to wonder why the galaxy went quiet.
  const crisis = view.act === 'CRISIS';

  return (
    <div className="card comms-card">
      <div className="comms-head">
        <h2>Comms</h2>
        <span className={`comms-act act-${view.act.toLowerCase()}`}>{view.act}</span>
      </div>

      {crisis && (
        <p className="comms-crisis">All channels clear — priority traffic only.</p>
      )}

      {/*
        Silence is this feature's failure mode, so it always explains itself.
        Without this the commander sees an empty panel and cannot tell a quiet
        system from a broken setting from a model that is not loaded.
      */}
      <div className="comms-diag">
        <span className="comms-diag-src">
          {view.diag.source === 'llm'
            ? 'AI · fresh'
            : view.diag.source === 'hybrid'
              ? 'AI + templates'
              : 'templates'}
        </span>
        <span>{view.diag.ready} ready now</span>
        <span>{Math.max(0, view.diag.pending - view.diag.ready)} writing</span>
        <span>
          {view.diag.spoken} on the air
          {view.diag.rejected > 0 && ` · ${view.diag.rejected} dropped${dominantDrop(view.diag.dropReasons)}`}
        </span>
        {view.diag.quiet && <span className="comms-diag-why">{quietLabel(view.diag.quiet)}</span>}
        {view.diag.lastGenAt > 0 && (
          <span className="comms-diag-last" title={view.diag.lastGenOutcome}>
            {view.diag.lastGenOutcome}
          </span>
        )}
      </div>

      <ul className="comms-channels">
        {view.channels.map((c) => (
          <ChannelRow
            key={c.id}
            state={c}
            muted={muted.has(c.id)}
            lastAt={view.lastPerChannel[c.id] ?? null}
            nowMs={nowMs}
            onToggle={onToggleChannel}
          />
        ))}
      </ul>

      {view.log.length === 0 ? (
        <p className="comms-empty">
          Nothing on the air yet. Traffic depends on where you are — a port in range,
          somebody else in the system, a carrier parked up.
        </p>
      ) : (
        <ul className="comms-log">
          {view.log.map((e, i) => (
            <Entry key={`${e.at}-${i}`} entry={e} nowMs={nowMs} />
          ))}
        </ul>
      )}
    </div>
  );
}
