// Persistence boundary for the curtailment-surplus refute ladder
// (`CurtailmentPersistedHoldState`), over `homey.settings`. The port type lives
// in the domain (`lib/solar/curtailmentSurplus.ts`); only this adapter knows
// Homey. Reads are validated at the boundary: ANY malformed field coerces the
// whole blob to `null` (fresh start) — a bad blob must never poison the
// estimator, and losing the ladder merely restores pre-persistence behavior
// (fail-open toward 15-min holds, never a crash). Writes are best-effort: a
// transient settings failure is swallowed, not thrown into the sample path.

import { CURTAILMENT_HOLD_STATE } from '../lib/utils/settingsKeys';
import {
  CURTAIL_HOLD_MAX_LEVEL,
  type CurtailmentHoldStore,
  type CurtailmentPersistedHoldState,
} from '../lib/solar/curtailmentSurplus';

type SettingsLike = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);

// A nullable epoch-ms field: null = "no active hold/latch", finite number = a
// deadline (expired values are fine — consumers compare against nowMs). Any
// other shape marks the field (and thus the blob) junk.
const readNullableMs = (value: unknown): { ok: boolean; value: number | null } => {
  if (value === null) return { ok: true, value: null };
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
  return { ok: false, value: null };
};

const normalize = (raw: unknown): CurtailmentPersistedHoldState | null => {
  if (!isRecord(raw)) return null;
  const { holdLevel } = raw;
  if (
    typeof holdLevel !== 'number'
    || !Number.isInteger(holdLevel)
    || holdLevel < 0
    || holdLevel > CURTAIL_HOLD_MAX_LEVEL
  ) return null;
  const holdUntilMs = readNullableMs(raw.holdUntilMs);
  const importLatchUntilMs = readNullableMs(raw.importLatchUntilMs);
  if (!holdUntilMs.ok || !importLatchUntilMs.ok) return null;
  return { holdLevel, holdUntilMs: holdUntilMs.value, importLatchUntilMs: importLatchUntilMs.value };
};

/** Build the typed hold store over Homey settings (junk-tolerant read, best-effort write). */
export function createCurtailmentHoldStore(settings: SettingsLike): CurtailmentHoldStore {
  return {
    read: (): CurtailmentPersistedHoldState | null => {
      try {
        return normalize(settings.get(CURTAILMENT_HOLD_STATE));
      } catch {
        // A transiently failing settings read starts fresh — never crashes boot.
        return null;
      }
    },
    write: (state: CurtailmentPersistedHoldState): void => {
      try {
        settings.set(CURTAILMENT_HOLD_STATE, state);
      } catch {
        // Best-effort: a failed persist just means a restart forgets the ladder
        // (the pre-persistence behavior). Never throw into the sample path.
      }
    },
  };
}
