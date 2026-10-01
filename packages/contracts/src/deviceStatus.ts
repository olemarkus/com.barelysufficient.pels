/**
 * A countdown on the reason line. `in_text`: the text names the remaining time
 * ("… in 45s"), which the UI interpolates between `prefix` and `suffix`.
 * `beside_text`: the text says something else (what the device still reports)
 * and the countdown shows only as the card's ring.
 */
export type DeviceStatusCountdown =
  | { kind: 'in_text'; endsAtMs: number; totalSec: number; prefix: string; suffix: string }
  | { kind: 'beside_text'; endsAtMs: number; totalSec: number };

/** Complete presentation, resolved by the backend. No actuation inputs. */
export type DeviceStatus = {
  cardKind: 'binary' | 'temperature' | 'stepped';
  kind: 'active' | 'idle' | 'held' | 'resuming' | 'off' | 'manual' | 'unavailable';
  tone: 'active' | 'idle' | 'held' | 'resuming' | 'neutral' | 'warning';
  label: string;
  powerText: string | null;
  powerVariant: 'live' | 'expected' | 'reported';
  factText: string | null;
  reason: {
    text: string;
    tone?: 'neutral' | 'warning';
    detail?: string;
    countdown?: DeviceStatusCountdown;
  } | null;
  rail: { labels: string[]; activeIndex: number | null } | null;
  limited: boolean;
  wouldLimit: boolean;
  canEaseOff: boolean;
  controlOffDrawing: boolean;
  holdCause: 'smart_task' | 'daily_budget' | null;
};
