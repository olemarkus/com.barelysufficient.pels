/**
 * A countdown on the reason line. `in_text`: the text names the remaining time
 * ("… in 45s"), which the UI interpolates between `prefix` and `suffix`.
 * `beside_text`: the text says something else (what the device still reports)
 * and the countdown shows only as the card's ring.
 */
export type DeviceStatusCountdown =
  | { kind: 'in_text'; endsAtMs: number; totalSec: number; prefix: string; suffix: string }
  | { kind: 'beside_text'; endsAtMs: number; totalSec: number };

/**
 * The device's own measure as numbers, for a surface that leads with a figure
 * (the device widget) rather than the `factText` sentence: a temperature
 * device's reading against the target PELS plans for, or a battery's level
 * (an EV's car, a home battery). Built beside `factText` from the same facts.
 */
export type DeviceStatusReading =
  | { kind: 'temperature'; currentC: number; targetC: number }
  | { kind: 'battery'; percent: number };

/** Complete presentation, resolved by the backend. No actuation inputs. */
export type DeviceStatus = {
  cardKind: 'binary' | 'temperature' | 'stepped';
  kind: 'active' | 'idle' | 'held' | 'resuming' | 'off' | 'manual' | 'unavailable';
  tone: 'active' | 'idle' | 'held' | 'resuming' | 'neutral' | 'warning';
  label: string;
  powerText: string | null;
  powerVariant: 'live' | 'expected' | 'reported';
  factText: string | null;
  // Null for a device with neither a temperature nor a known battery level:
  // its measure is its draw (`powerText`).
  reading: DeviceStatusReading | null;
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
  holdCause: 'smart_task' | 'smart_task_done' | 'daily_budget' | null;
};
