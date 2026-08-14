/**
 * The local wire — a fictional paper for the system the commander is in.
 *
 * Laid out as a concourse feed rather than a chat log: a masthead naming the
 * system, then stories with the newest at the top. Everything here was written
 * from journal facts (the faction board, the stations, the construction
 * sites), so it reads as reporting rather than as the operator talking.
 */
import type { NewsView } from './store.ts';
import { DESK_LABEL, type NewsItem } from '../engine/news.ts';

const ago = (iso: string, nowMs: number): string => {
  const mins = Math.floor((nowMs - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

function Story({ item, nowMs, faded }: { item: NewsItem; nowMs: number; faded?: boolean }) {
  return (
    <li className={faded ? 'news-item faded' : 'news-item'}>
      <div className="news-headline">{item.headline}</div>
      <div className="news-body">{item.body}</div>
      <div className="news-meta">
        {item.desk && <span className={`news-desk desk-${item.desk}`}>{DESK_LABEL[item.desk]}</span>}
        {faded ? `${item.system} · ` : ''}
        {ago(item.at, nowMs)}
      </div>
    </li>
  );
}

export function NewsCard({
  view,
  nowMs,
  onRefresh,
}: {
  view: NewsView;
  nowMs: number;
  onRefresh: () => void;
}) {
  const cadence = view.everyMin > 0 ? `every ${view.everyMin} min` : 'manual only';
  return (
    <div className="card news-card">
      <div className="news-head">
        <div className="news-title">📰 {view.system} Local Wire</div>
        <div className="news-sub">
          {view.busy ? 'going to press…' : view.lastAt ? `filed ${ago(new Date(view.lastAt).toISOString(), nowMs)}` : 'no edition yet'}
          {` · ${cadence}`}
        </div>
      </div>

      <div className="news-tools">
        <button className="news-refresh" disabled={view.busy} onClick={onRefresh}>
          {view.busy ? 'Writing…' : 'New edition'}
        </button>
        <span className="news-note">Written from this system’s own faction, station and site data.</span>
      </div>

      {view.error && <div className="news-warn">{view.error}</div>}

      {!view.items.length && !view.busy && !view.error && (
        <div className="news-empty">
          Nothing filed for {view.system} yet. The wire writes on its own schedule, or press
          <b> New edition</b>.
        </div>
      )}

      <ul className="news-list">
        {view.items.map((n, i) => (
          <Story key={`${n.at}-${i}`} item={n} nowMs={nowMs} />
        ))}
      </ul>

      {view.archive.length > 0 && (
        <>
          <div className="news-divider">Filed elsewhere</div>
          <ul className="news-list">
            {view.archive.map((n, i) => (
              <Story key={`a-${n.at}-${i}`} item={n} nowMs={nowMs} faded />
            ))}
          </ul>
        </>
      )}

      <div className="news-foot">
        Fiction, written by the local model from real journal data — not a Galnet feed.
      </div>
    </div>
  );
}
