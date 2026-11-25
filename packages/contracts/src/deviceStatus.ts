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

/** A user-visible condition, resolved by the evidence owner. */
export type DecisionCheck = {
  label: string;
  state: 'met' | 'waiting' | 'not_checked' | 'unverified';
  detail?: string;
};

/** Complete presentation, resolved by the backend. No actuation inputs. */
export type DeviceStatus = {
  cardKind: 'binary' | 'temperature' | 'stepped';
  kind: 'active' | 'idle' | 'held' | 'resuming' | 'off' | 'manual' | 'unavailable';
  tone: 'active' | 'idle' | 'held' | 'resuming' | 'neutral' | 'warning';
  label: string;
  powerText: string | null;
  powerVariant: 'live' | 'expected' | 'reported' | 'before_switch_off';
  factText: string | null;
  /**
   * For the device page header, when the device's own setpoint differs from the
   * one PELS will write: both, with when PELS writes it and why it is that value,
   * as a sentence (`Set to 28 °C. PELS sets 22 °C when it resumes the device
   * (override).`). The fact line carries the same pair in short form.
   */
  targetDetail?: string;
  // Null for a device with neither a temperature nor a known battery level:
  // its measure is its draw (`powerText`).
  reading: DeviceStatusReading | null;
  reason: {
    /** The device's phase is unknown and it waits for room: the card offers the setting quietly. */
    offersPhaseSetting?: true;
    /** The device needs its Energy values configured in Homey's device settings. */
    offersHomeyEnergySetup?: true;
    /** PELS will not identify the charger's car by itself: the card offers to confirm it. */
    offersCarConfirmation?: true;
    /** The card can open a problem report about this reason. */
    offersProblemReport?: true;
    text: string;
    tone?: 'neutral' | 'warning';
    detail?: string;
    chargingStartChecks?: DecisionCheck[];
    countdown?: DeviceStatusCountdown;
  } | null;
  rail: { labels: string[]; activeIndex: number | null } | null;
  limited: boolean;
  wouldLimit: boolean;
  canEaseOff: boolean;
  controlOffDrawing: boolean;
  /** An override is in force on the device: the card shows the Override chip. */
  override?: true;
  /** The phase this device is held for, when a phase is what holds it. */
  heldForPhase?: 'L1' | 'L2' | 'L3';
  holdCause: 'smart_task' | 'smart_task_done' | 'daily_budget' | null;
  /**
   * Built-in current control is selected, but the charger's installed app no
   * longer offers a way to set the current: PELS only switches the charger until
   * the owner updates the app. The card shows an amber warning.
   */
  needsChargerAppUpdate?: true;
  /** Temperature control works, but power limiting needs a device reading. */
  powerLimitingNeedsReading?: true;
};
