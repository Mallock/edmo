/** Operator console — event feed, heartbeat nudges, and AI chat exchanges.
 *  Sticks to the newest entry whenever content grows (ResizeObserver — robust
 *  against streaming tokens and late emoji/font layout shifts); scrolling up
 *  pauses following until the ⤓ button or scrolling back down. */
import { useEffect, useRef, useState } from 'react';
import type { FeedEntry } from './store.ts';
import { clockTime } from './util.ts';

const KIND_ICON: Record<string, string> = {
  briefing: '📋',
  redirect: '🎯',
  arrival: '🛬',
  complete: '✅',
  cargo: '📦',
  abandoned: '🚫',
  failed: '❌',
  nudge: '💡',
  user: '»',
  ai: '🤖',
  story: '📖',
  combat: '⚔️',
  saga: '📜',
  memory: '🧠',
  vision: '👁',
  system: '·',
};

const STICK_THRESHOLD_PX = 60;

export function Feed({ entries }: { entries: FeedEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [following, setFollowing] = useState(true);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return undefined;
    // Any growth of the content (new entries, streaming text, glyph loads,
    // window resize) re-pins the view while following is active.
    const ro = new ResizeObserver(() => {
      if (stick.current) scrollToBottom();
    });
    ro.observe(inner);
    scrollToBottom();
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    stick.current = nearBottom;
    setFollowing(nearBottom);
  };

  return (
    <div className="feed-wrap">
      <div className="feed" ref={scrollRef} onScroll={onScroll} role="log" aria-label="Operator feed">
        <div className="feed-inner" ref={innerRef}>
          {entries.length === 0 && (
            <div className="feed-empty">Operator standing by — waiting for journal activity…</div>
          )}
          {entries.map((e) => (
            <div key={e.id} className={feedClass(e)}>
              <span className="feed-time mono">{clockTime(e.time)}</span>
              <span className="feed-icon" aria-hidden="true">
                {KIND_ICON[e.kind] ?? '·'}
              </span>
              <span className="feed-text">
                {e.text}
                {e.streaming && <span className="cursor">▋</span>}
              </span>
            </div>
          ))}
        </div>
      </div>
      {!following && (
        <button
          className="feed-jump"
          aria-label="Jump to latest"
          onClick={() => {
            stick.current = true;
            setFollowing(true);
            scrollToBottom();
          }}
        >
          ⤓ latest
        </button>
      )}
    </div>
  );
}

function feedClass(e: FeedEntry): string {
  const bits = ['feed-entry', `k-${e.kind}`];
  if (e.severity) bits.push(`sev-${e.severity}`);
  return bits.join(' ');
}
