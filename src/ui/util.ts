/** Small UI helpers: category colors (SPEC §5.2) and time formatting. */
import type { Mission, MissionCategory } from '../engine/types.ts';

export const CATEGORY_COLORS: Record<MissionCategory, string> = {
  Courier: '#f0a030',
  Delivery: '#f0a030',
  DeliveryWing: '#f0a030',
  Massacre: '#e03030',
  Assassinate: '#e03030',
  Salvage: '#40d0f0',
  Collect: '#40d0f0',
  Rescue: '#40e060',
  Mining: '#f08030',
  PassengerVIP: '#a060f0',
  Sightseeing: '#a060f0',
  LongDistanceExpedition: '#a060f0',
  PassengerBulk: '#4080f0',
  Donation: '#40e060',
  Scan: '#40d0f0',
  Hack: '#40d0f0',
  Disable: '#e03030',
  Smuggle: '#f08030',
  OnFoot: '#a0c060',
  Other: '#808090',
};

export function categoryColor(c: MissionCategory): string {
  return CATEGORY_COLORS[c] ?? CATEGORY_COLORS.Other;
}

export function categoryLabel(m: Mission): string {
  const base = m.category.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
  return m.bgsState ? `${base} · ${m.bgsState.toUpperCase()}` : base;
}

/** "9h 12m", "14m 03s" under 15 min, "EXPIRED" when past. */
export function countdown(expiryIso: string | null, nowMs: number): string {
  if (!expiryIso) return '—';
  const ms = Date.parse(expiryIso) - nowMs;
  if (Number.isNaN(ms)) return '—';
  if (ms <= 0) return 'EXPIRED';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m >= 15) return `${m}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function expiryMinutes(expiryIso: string | null, nowMs: number): number {
  if (!expiryIso) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(expiryIso) - nowMs;
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms / 60000;
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function credits(n: number): string {
  return `${n.toLocaleString('en-US')} cr`;
}
