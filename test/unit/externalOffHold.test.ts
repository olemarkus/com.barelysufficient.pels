import { describe, expect, it, vi } from 'vitest';
import {
  EXTERNAL_OFF_HOLD_LOAD_GRACE_MS,
  EXTERNAL_OFF_HOLD_RELOAD_RETRY_MS,
  EXTERNAL_OFF_HOLD_VERSION,
  createExternalOffHoldPolicy,
  type ExternalOffHoldOptInRead,
  type PersistedExternalOffHolds,
} from '../../lib/observer/externalOffHold';
import { createExternalOffHoldPolicy as createSettingsExternalOffHoldPolicy } from '../../setup/externalOffHoldAdapter';
import {
  EXTERNAL_OFF_HOLDS,
  EXTERNAL_OFF_HOLDS_INITIALIZED,
  RESPECT_EXTERNAL_OFF_DEVICES,
} from '../../lib/utils/settingsKeys';

// Unit tier: the policy is a pure function of its injected seams — no SDK, no
// real clock. The rules under test are the ones `notes/persisted-settings-state.md`
// says get reimplemented wrong every time: junk-tolerant load, never-wipe, and
// dirty-gated writes.

const NOW = 1_000_000;

const persisted = (entries: Record<string, unknown>): unknown => ({
  version: EXTERNAL_OFF_HOLD_VERSION,
  entriesByDeviceId: entries,
});

const optedIn = (optIn: Record<string, boolean>): ExternalOffHoldOptInRead => (
  { status: 'resolved', optIn }
);

const build = (overrides: Parameters<typeof createExternalOffHoldPolicy>[0] = {}) => (
  createExternalOffHoldPolicy({
    nowMs: () => NOW,
    readOptIn: () => optedIn({ a: true, b: true }),
    ...overrides,
  })
);

describe('external-off hold policy — load', () => {
  it('restores a valid persisted hold', () => {
    const policy = build({ load: () => persisted({ a: { sinceMs: 500 } }) });
    expect(policy.isHeld('a')).toBe(true);
  });

  it('treats a throwing read as no persisted state instead of crashing', () => {
    const policy = build({ load: () => { throw new Error('settings unavailable'); } });
    expect(policy.heldDeviceIds()).toEqual([]);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a wrong version', { version: 2, entriesByDeviceId: { a: { sinceMs: 1 } } }],
    ['a non-object entry map', { version: EXTERNAL_OFF_HOLD_VERSION, entriesByDeviceId: [] }],
  ])('rejects %s payload', (_label, raw) => {
    expect(build({ load: () => raw }).heldDeviceIds()).toEqual([]);
  });

  it('skips a corrupt entry without discarding its healthy siblings', () => {
    const policy = build({
      load: () => persisted({
        a: { sinceMs: 500 },
        nonFinite: { sinceMs: Number.NaN },
        infinite: { sinceMs: Number.POSITIVE_INFINITY },
        negative: { sinceMs: -1 },
        notAnObject: 'nope',
      }),
      readOptIn: () => optedIn({
        a: true, nonFinite: true, infinite: true, negative: true, notAnObject: true,
      }),
    });
    expect(policy.heldDeviceIds()).toEqual(['a']);
  });

  it('drops unknown keys rather than round-tripping them into the next write', () => {
    const save = vi.fn();
    const policy = build({
      load: () => persisted({ a: { sinceMs: 500, bogus: 'junk' } }),
      save,
    });
    policy.startHold('b');
    expect(save.mock.calls[0][0].entriesByDeviceId.a).toEqual({ sinceMs: 500 });
  });
});

describe('external-off hold policy — abandon grace after a bad load', () => {
  it('refuses to persist after a failed read, so other devices are not wiped', () => {
    const save = vi.fn();
    const policy = build({
      load: () => { throw new Error('boom'); },
      hasWrittenBefore: () => true,
      save,
    });
    // The in-memory map is empty; without the grace, this write would replace
    // the persisted blob with `{ a }` and erase every other device's hold.
    expect(policy.startHold('a')).toBe(true);
    expect(policy.isHeld('a')).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses to persist after a malformed read even on a first install', () => {
    const save = vi.fn();
    const policy = build({ load: () => 'garbage', hasWrittenBefore: () => false, save });
    policy.startHold('a');
    expect(save).not.toHaveBeenCalled();
  });

  it('persists immediately on a genuine fresh install', () => {
    const save = vi.fn();
    const policy = build({ load: () => undefined, hasWrittenBefore: () => false, save });
    policy.startHold('a');
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toEqual({
      version: EXTERNAL_OFF_HOLD_VERSION,
      entriesByDeviceId: { a: { sinceMs: NOW } },
    });
  });

  it('flushes the withheld mutation once the grace window has elapsed', () => {
    const save = vi.fn();
    let clock = NOW;
    const policy = createExternalOffHoldPolicy({
      nowMs: () => clock,
      readOptIn: () => optedIn({ a: true }),
      load: () => undefined,
      hasWrittenBefore: () => true,
      save,
    });
    policy.startHold('a');
    expect(save).not.toHaveBeenCalled();
    // Repeating the start is a no-op, so the hold would be lost at the next
    // restart unless the withheld write is retained and flushed on its own.
    clock = NOW + EXTERNAL_OFF_HOLD_LOAD_GRACE_MS + 1;
    expect(policy.isHeld('a')).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].entriesByDeviceId).toEqual({ a: { sinceMs: NOW } });
  });

  it('retries a save that threw rather than dropping the hold', () => {
    const save = vi.fn<(holds: PersistedExternalOffHolds) => void>();
    save.mockImplementation(() => { throw new Error('settings write failed'); });
    const policy = build({ load: () => undefined, save });
    policy.startHold('a');
    expect(save).toHaveBeenCalledTimes(1);
    save.mockImplementation(() => {});
    policy.isHeld('a');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].entriesByDeviceId).toEqual({ a: { sinceMs: NOW } });
  });

  it('fails closed for EVERY device while both settings reads are unavailable', () => {
    // Cold restart with the settings service down: we cannot read the holds, and
    // we cannot read the opt-in map either — so we cannot even name the devices
    // that might be held. Answering "not held" here resumes them.
    const policy = createExternalOffHoldPolicy({
      nowMs: () => NOW,
      load: () => { throw new Error('settings unavailable'); },
      hasWrittenBefore: () => true,
      readOptIn: () => ({ status: 'unavailable' }),
    });
    expect(policy.isHeld('a')).toBe(true);
    expect(policy.isHeld('anything-else')).toBe(true);
  });
});

describe('external-off hold policy — mutations', () => {
  it('reports a new hold and persists it', () => {
    const save = vi.fn();
    const policy = build({ load: () => undefined, save });
    expect(policy.startHold('a')).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('treats a duplicate start as a no-op — no write', () => {
    const save = vi.fn();
    const policy = build({ load: () => undefined, save });
    policy.startHold('a');
    save.mockClear();
    expect(policy.startHold('a')).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('clears only a hold that was actually present', () => {
    const save = vi.fn();
    const policy = build({ load: () => persisted({ a: { sinceMs: 500 } }), save });
    expect(policy.clearHold('a')).toBe(true);
    save.mockClear();
    expect(policy.clearHold('a')).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps the in-memory hold authoritative when the write throws', () => {
    const policy = build({
      load: () => undefined,
      save: () => { throw new Error('settings write failed'); },
    });
    expect(policy.startHold('a')).toBe(true);
    expect(policy.isHeld('a')).toBe(true);
  });
});

// The dangerous confusion this feature has to survive: an unreadable state is
// not an empty one. Answering "no holds" to either read is a resume — exactly
// what the user's off action was supposed to prevent.
describe('external-off hold policy — unavailable is not empty', () => {
  it('keeps an opted-in device held while the persisted state cannot be read', () => {
    const policy = build({
      load: () => { throw new Error('settings unavailable'); },
      hasWrittenBefore: () => true,
    });
    // We cannot know whether `a` has a hold, and guessing "no" resumes it.
    expect(policy.isHeld('a')).toBe(true);
    // Never for a device that did not opt in: the default stays off.
    expect(policy.isHeld('other')).toBe(false);
  });

  it('adopts the real holds once a retry succeeds, and stops guessing', () => {
    let clock = NOW;
    let broken = true;
    const save = vi.fn();
    const policy = createExternalOffHoldPolicy({
      nowMs: () => clock,
      readOptIn: () => optedIn({ a: true, b: true }),
      hasWrittenBefore: () => true,
      load: () => {
        if (broken) throw new Error('settings unavailable');
        return persisted({ b: { sinceMs: 500 } });
      },
      save,
    });
    policy.startHold('a');
    expect(save).not.toHaveBeenCalled();
    broken = false;
    clock = NOW + EXTERNAL_OFF_HOLD_RELOAD_RETRY_MS + 1;
    // The recovered read merges under the hold started meanwhile, and the union
    // is written back — neither side may be lost.
    expect(policy.heldDeviceIds().sort()).toEqual(['a', 'b']);
    expect(save).toHaveBeenCalledTimes(1);
    expect(policy.isHeld('unrelated')).toBe(false);
  });

  it('replays a release against the recovered read instead of resurrecting the hold', () => {
    let clock = NOW;
    let broken = true;
    const policy = createExternalOffHoldPolicy({
      nowMs: () => clock,
      readOptIn: () => optedIn({ a: true }),
      hasWrittenBefore: () => true,
      load: () => {
        if (broken) throw new Error('settings unavailable');
        return persisted({ a: { sinceMs: 500 } });
      },
    });
    // The device is turned on while the map is unreadable, so the delete lands
    // on nothing. Without a tombstone the recovered read revives the hold — and
    // if PELS has limited the device again by then it is off, so the observed-ON
    // sweep never clears it either and the device is stranded.
    policy.clearHold('a');
    broken = false;
    clock = NOW + EXTERNAL_OFF_HOLD_RELOAD_RETRY_MS + 1;
    expect(policy.heldDeviceIds()).toEqual([]);
    expect(policy.isHeld('a')).toBe(false);
  });

  it('retries a de-opt whose settings-change read failed, on the next plan cycle', () => {
    let read: ExternalOffHoldOptInRead = optedIn({ a: true });
    const policy = createExternalOffHoldPolicy({
      nowMs: () => NOW,
      load: () => persisted({ a: { sinceMs: 500 } }),
      readOptIn: () => read,
    });
    // The user opts out, but the read triggered by that change fails, so the
    // one-shot reconciliation sees the device as still opted in.
    read = { status: 'unavailable' };
    expect(policy.releaseDeOptedHolds()).toEqual([]);
    expect(policy.isHeld('a')).toBe(true);
    // Nothing else would ever retry it. The pull-path sweep reconciles instead.
    read = optedIn({});
    expect(policy.heldDeviceIds()).toEqual([]);
  });

  it('does not release restored holds when the opt-in map cannot be read', () => {
    const save = vi.fn();
    const policy = createExternalOffHoldPolicy({
      nowMs: () => NOW,
      load: () => persisted({ a: { sinceMs: 500 } }),
      // Reading the opt-in map fails at construction. Treating that as `{}`
      // would make every restored hold look de-opted, and the constructor would
      // clear and persist an empty map — permanently resuming those devices.
      readOptIn: () => ({ status: 'unavailable' }),
      save,
    });
    expect(policy.isHeld('a')).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('reconciles the opt-out as soon as the map does resolve', () => {
    let read: ExternalOffHoldOptInRead = { status: 'unavailable' };
    const policy = createExternalOffHoldPolicy({
      nowMs: () => NOW,
      load: () => persisted({ a: { sinceMs: 500 } }),
      readOptIn: () => read,
    });
    expect(policy.isHeld('a')).toBe(true);
    read = optedIn({});
    expect(policy.releaseDeOptedHolds()).toEqual(['a']);
    expect(policy.isHeld('a')).toBe(false);
  });
});

// The adapter is a pure function of an injected `settings` object, so its
// classification of a flaky store belongs here rather than at a wider tier.
describe('external-off hold settings adapter — a flaky store', () => {
  const buildSettings = (params: {
    values?: Record<string, unknown>;
    failSetKeys?: Set<string>;
  } = {}) => {
    const values = new Map(Object.entries(params.values ?? {}));
    const setCalls: string[] = [];
    return {
      values,
      setCalls,
      settings: {
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => {
          setCalls.push(key);
          if (params.failSetKeys?.has(key)) throw new Error('settings write failed');
          values.set(key, value);
        },
      },
    };
  };

  it('retries the whole persist when the written-before marker cannot be written', () => {
    // The marker travels WITH the blob: dropping it as best-effort would make a
    // later restart whose blob read transiently fails look like a fresh install,
    // which skips the grace window and can wipe every hold. A failed marker must
    // therefore fail the save, so the domain's pending-write retry covers it.
    const failing = new Set([EXTERNAL_OFF_HOLDS_INITIALIZED]);
    const store = buildSettings({
      values: { [RESPECT_EXTERNAL_OFF_DEVICES]: { a: true } },
      failSetKeys: failing,
    });
    const policy = createSettingsExternalOffHoldPolicy(store.settings);
    policy.startHold('a');
    expect(store.values.get(EXTERNAL_OFF_HOLDS_INITIALIZED)).toBeUndefined();

    // No further mutation — an ordinary read is enough to drive the retry.
    failing.clear();
    expect(policy.isHeld('a')).toBe(true);
    expect(store.values.get(EXTERNAL_OFF_HOLDS_INITIALIZED)).toBe(true);
    expect(store.values.get(EXTERNAL_OFF_HOLDS)).toBeDefined();
  });

  it('does not treat an unreadable opt-in map as an empty one', () => {
    const store = buildSettings({
      values: {
        [EXTERNAL_OFF_HOLDS]: persisted({ a: { sinceMs: 500 } }),
        [EXTERNAL_OFF_HOLDS_INITIALIZED]: true,
      },
    });
    const policy = createSettingsExternalOffHoldPolicy({
      ...store.settings,
      get: (key: string) => {
        if (key === RESPECT_EXTERNAL_OFF_DEVICES) throw new Error('settings unavailable');
        return store.values.get(key);
      },
    });
    // The restored hold survives, and nothing was re-persisted over it.
    expect(policy.isHeld('a')).toBe(true);
    expect(store.setCalls).toEqual([]);
  });
});

describe('external-off hold policy — opt-in reconciliation', () => {
  it('drops a reloaded hold whose opt-in was cleared while the app was down', () => {
    const policy = createExternalOffHoldPolicy({
      nowMs: () => NOW,
      load: () => persisted({ a: { sinceMs: 500 } }),
      readOptIn: () => optedIn({}),
    });
    expect(policy.isHeld('a')).toBe(false);
  });

  it('keeps a reloaded hold whose device is still opted in', () => {
    const policy = build({ load: () => persisted({ a: { sinceMs: 500 } }) });
    expect(policy.isHeld('a')).toBe(true);
  });

  it('releases exactly the de-opted devices on a settings change', () => {
    let optIn: Record<string, boolean> = { a: true, b: true };
    const policy = createExternalOffHoldPolicy({
      nowMs: () => NOW,
      load: () => persisted({ a: { sinceMs: 500 }, b: { sinceMs: 500 } }),
      readOptIn: () => optedIn(optIn),
    });
    optIn = { b: true };
    expect(policy.releaseDeOptedHolds()).toEqual(['a']);
    expect(policy.isHeld('b')).toBe(true);
  });

  it('reads the opt-in live so a just-toggled device takes effect', () => {
    let optIn: Record<string, boolean> = {};
    const policy = createExternalOffHoldPolicy({
      nowMs: () => NOW,
      readOptIn: () => optedIn(optIn),
    });
    expect(policy.isEnabledForDevice('a')).toBe(false);
    optIn = { a: true };
    expect(policy.isEnabledForDevice('a')).toBe(true);
  });
});
