// Persistence boundary for the curtailment-surplus refute ladder + armed latch
// (`CurtailmentPersistedHoldState`), over `homey.settings`. The port type lives
// in the domain (`lib/solar/curtailmentSurplus.ts`); only this adapter knows
// Homey.
//
// Reads are validated AND classified here, per the boundary rule: a malformed
// blob is a resolved `null` (fresh start — a bad blob must never poison the
// estimator), while a THROWN read is `unavailable`. Those are different facts
// and the caller acts on them differently: absence permits a write, an
// unavailable read forbids one, because overwriting an unread ladder with a
// blank one is a destructive reset of persisted state on a transient failure
// (root `AGENTS.md`; `notes/persisted-settings-state.md`).
//
// Writes stay best-effort — never thrown into the sample path — but now REPORT
// whether the value landed, so the caller can retry instead of assuming.

import { CURTAILMENT_HOLD_STATE } from '../lib/utils/settingsKeys';
import {
  CURTAIL_HOLD_MAX_LEVEL,
  type CurtailmentHoldRead,
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
  // `armed` is absent on blobs written before it existed, and only an explicit
  // `true` arms — absent/junk means "not proven", which costs one production
  // sample to re-earn rather than fabricating a capability. Any OTHER type is
  // junk and condemns the blob, consistent with every field above.
  if (raw.armed !== undefined && typeof raw.armed !== 'boolean') return null;
  return {
    holdLevel,
    holdUntilMs: holdUntilMs.value,
    importLatchUntilMs: importLatchUntilMs.value,
    ...(raw.armed === true ? { armed: true } : {}),
  };
};

/** Build the typed hold store over Homey settings (junk-tolerant read, best-effort write). */
export function createCurtailmentHoldStore(settings: SettingsLike): CurtailmentHoldStore {
  return {
    read: (): CurtailmentHoldRead => {
      try {
        return { state: 'resolved', value: normalize(settings.get(CURTAILMENT_HOLD_STATE)) };
      } catch {
        // The store could not answer. NOT the same as "nothing stored" — never
        // crashes boot, and never licenses a write over what is still there.
        return { state: 'unavailable' };
      }
    },
    write: (state: CurtailmentPersistedHoldState): boolean => {
      try {
        settings.set(CURTAILMENT_HOLD_STATE, state);
        return true;
      } catch {
        // Best-effort: never throw into the sample path. Reporting the failure
        // lets the caller retry, which matters for the armed latch — a silently
        // dropped write is invisible until the restart it was meant to survive.
        return false;
      }
    },
  };
}
