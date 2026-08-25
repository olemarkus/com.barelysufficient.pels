// Persistence boundary for the curtailment-surplus refute ladder + armed latch
// (`CurtailmentPersistedHoldState`), over `homey.settings`. The port type lives
// in the domain (`lib/solar/curtailmentSurplus.ts`); only this adapter knows
// Homey.
//
// Reads are validated AND classified here, per the boundary rule, into the
// three arms the caller acts on differently: `loaded` (a validated blob),
// `absent` (genuinely no state, or a malformed blob — a bad blob must never
// poison the estimator, so junk is a safe fresh start), and `unreadable` (the
// read THREW, or an empty read the key list contradicts — a transient SDK
// miss, so what is on disk is UNKNOWN). Absence permits a write; an unreadable
// read forbids one, because overwriting an unread ladder with a blank one is a
// destructive reset of persisted state on a transient failure (root
// `AGENTS.md`; `notes/persisted-settings-state.md`).
//
// Writes stay best-effort — never thrown into the sample path — but REPORT
// whether the value landed, so the caller can retry instead of assuming.

import { CURTAILMENT_HOLD_STATE } from '../lib/utils/settingsKeys';
import {
  CURTAIL_HOLD_MAX_LEVEL,
  type CurtailmentHoldRead,
  type CurtailmentHoldReadResolved,
  type CurtailmentHoldStore,
  type CurtailmentPersistedHoldState,
} from '../lib/solar/curtailmentSurplus';

type SettingsLike = {
  get: (key: string) => unknown;
  getKeys: () => string[];
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

// Classify a PRESENT raw value. Junk anywhere condemns the whole blob to
// `absent` (fresh start), never a partially-trusted state. This helper never
// claims `unreadable` — that arm belongs to the reader (a thrown or
// key-list-contradicted read), not to the value's shape.
const normalize = (raw: unknown): CurtailmentHoldReadResolved => {
  if (!isRecord(raw)) return { state: 'absent' };
  const { holdLevel } = raw;
  if (
    typeof holdLevel !== 'number'
    || !Number.isInteger(holdLevel)
    || holdLevel < 0
    || holdLevel > CURTAIL_HOLD_MAX_LEVEL
  ) return { state: 'absent' };
  const holdUntilMs = readNullableMs(raw.holdUntilMs);
  const importLatchUntilMs = readNullableMs(raw.importLatchUntilMs);
  if (!holdUntilMs.ok || !importLatchUntilMs.ok) return { state: 'absent' };
  // `armed` is absent on blobs written before it existed, and only an explicit
  // `true` arms — absent/junk means "not proven", which costs one production
  // sample to re-earn rather than fabricating a capability. Any OTHER type is
  // junk and condemns the blob, consistent with every field above.
  if (raw.armed !== undefined && typeof raw.armed !== 'boolean') return { state: 'absent' };
  return {
    state: 'loaded',
    value: {
      holdLevel,
      holdUntilMs: holdUntilMs.value,
      importLatchUntilMs: importLatchUntilMs.value,
      ...(raw.armed === true ? { armed: true } : {}),
    },
  };
};

// An empty read (`null`/`undefined` — the SDK answers `null` for an unset key)
// is only GENUINELY absent when the key list agrees. A key the list vouches
// for that still reads empty is a transient SDK miss, an empty key list cannot
// vouch for anything, and neither can a malformed one (the shape guard mirrors
// the repo's other key-list readers) — all classify `unreadable`
// (`setup/AGENTS.md`, "classify absence on both").
const classifyEmptyRead = (settings: SettingsLike): CurtailmentHoldRead => {
  const keys: unknown = settings.getKeys();
  if (
    !Array.isArray(keys)
    || keys.length === 0
    || !keys.every((key): key is string => typeof key === 'string')
  ) return { state: 'unreadable' };
  return keys.includes(CURTAILMENT_HOLD_STATE) ? { state: 'unreadable' } : { state: 'absent' };
};

/** Build the typed hold store over Homey settings (junk-tolerant read, best-effort write). */
export function createCurtailmentHoldStore(settings: SettingsLike): CurtailmentHoldStore {
  return {
    read: (): CurtailmentHoldRead => {
      try {
        const raw = settings.get(CURTAILMENT_HOLD_STATE);
        if (raw === null || raw === undefined) return classifyEmptyRead(settings);
        return normalize(raw);
      } catch {
        // The store could not answer. NOT the same as "nothing stored" — never
        // crashes boot, and never licenses a write over what is still there.
        return { state: 'unreadable' };
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
