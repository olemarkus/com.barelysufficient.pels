import { describe, expect, it, vi } from 'vitest';
import {
  clearObjectiveForDevice,
  upsertObjectiveForDevice,
  type DeferredObjectiveDeviceWriteDeps,
} from '../../lib/objectives/deferredObjectives/objectiveWrite';
import {
  PER_DEVICE_OBJECTIVE_KEY_PREFIX,
  readObjectiveForDevice,
  type ObjectiveSettingsStore,
} from '../../lib/objectives/deferredObjectives/objectiveStore';
import type { DeferredObjectiveActivePlanRecorder } from '../../lib/objectives/deferredObjectives/activePlanRecorder';
import type { DeferredObjectivePlanHistoryRecorder } from '../../lib/objectives/deferredObjectives/planHistory';
import type { DeferredObjectiveSettingsEntry } from '../../lib/objectives/deferredObjectives/settings';

const NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const DEADLINE_MS = NOW_MS + 6 * 60 * 60 * 1000;

const evEntry: DeferredObjectiveSettingsEntry = {
  enabled: true,
  kind: 'ev_soc',
  enforcement: 'soft',
  targetPercent: 80,
  deadlineAtMs: DEADLINE_MS,
};


const keyFor = (deviceId: string): string => `${PER_DEVICE_OBJECTIVE_KEY_PREFIX}${deviceId}`;

// In-memory store standing in for `homey.settings` (structurally an
// ObjectiveSettingsStore). Per-key set/unset keep the live key list consistent.
const buildStore = (
  seed: Record<string, DeferredObjectiveSettingsEntry> = {},
): ObjectiveSettingsStore & { raw: Map<string, unknown> } => {
  const raw = new Map<string, unknown>();
  // A real PELS store always carries non-objective settings keys, so getKeys() is
  // never empty in production (the trustworthy-absence guard relies on this — an
  // empty key list signals a transient store-wide flake, not a fresh create).
  raw.set('capacity_limit_kw', 5);
  for (const [deviceId, entry] of Object.entries(seed)) raw.set(keyFor(deviceId), entry);
  return {
    raw,
    get: (key) => raw.get(key),
    set: (key, value) => { raw.set(key, value); },
    unset: (key) => { raw.delete(key); },
    getKeys: () => [...raw.keys()],
  };
};

// ─── Device-scoped operations (per-device-key) ───────────────────────────────

describe('device-scoped objective ops (per-device-key)', () => {
  const buildDeviceDeps = (
    store: ObjectiveSettingsStore,
  ) => {
    const activePlanRecorder = {
      markPending: vi.fn(),
      clearForDevice: vi.fn(),
      flushIfDirty: vi.fn(),
    } as unknown as DeferredObjectiveActivePlanRecorder;
    const planHistoryRecorder = {
      finalizeForUserChange: vi.fn(),
      finalizeElapsedDeadline: vi.fn(),
      flushIfDirty: vi.fn(),
    } as unknown as DeferredObjectivePlanHistoryRecorder;
    const rebuildPlan = vi.fn();
    const debugStructured = vi.fn();
    const deps: DeferredObjectiveDeviceWriteDeps = {
      store,
      activePlanRecorder,
      planHistoryRecorder,
      rebuildPlan,
      nowMs: NOW_MS,
      debugStructured,
    };
    return { deps, activePlanRecorder, planHistoryRecorder, rebuildPlan, debugStructured };
  };

  it('upsert writes the device key and runs notify→flush→rebuild for a fresh create', () => {
    const store = buildStore();
    const h = buildDeviceDeps(store);
    upsertObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway', entry: evEntry });
    expect(readObjectiveForDevice(store, 'ev-1')).toEqual(evEntry);
    expect(h.activePlanRecorder.markPending).toHaveBeenCalledOnce();
    expect(h.planHistoryRecorder.finalizeForUserChange).not.toHaveBeenCalled();
    expect(h.activePlanRecorder.flushIfDirty).toHaveBeenCalledOnce();
    expect(h.planHistoryRecorder.flushIfDirty).toHaveBeenCalledOnce();
    expect(h.rebuildPlan).toHaveBeenCalledOnce();
  });

  it('PER-KEY ISOLATION: writing device A never touches device B\'s key (clobber-immunity proof)', () => {
    const store = buildStore({ 'ev-1': evEntry });
    const h = buildDeviceDeps(store);
    upsertObjectiveForDevice(h.deps, { deviceId: 'ev-2', deviceName: 'Garage', entry: evEntry });
    // Both keys present; ev-1's entry is byte-for-byte untouched.
    expect(readObjectiveForDevice(store, 'ev-1')).toEqual(evEntry);
    expect(readObjectiveForDevice(store, 'ev-2')).toEqual(evEntry);
    expect(store.getKeys().filter((k) => k.startsWith(PER_DEVICE_OBJECTIVE_KEY_PREFIX)).sort())
      .toEqual([keyFor('ev-1'), keyFor('ev-2')]);
  });

  it('clear unsets ONLY the target device\'s key, leaving siblings intact', () => {
    const store = buildStore({ 'ev-1': evEntry, 'ev-2': { ...evEntry, targetPercent: 50 } });
    const h = buildDeviceDeps(store);
    clearObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway' });
    expect(readObjectiveForDevice(store, 'ev-1')).toBeUndefined();
    // Sibling key survives the clear.
    expect(readObjectiveForDevice(store, 'ev-2')).toEqual({ ...evEntry, targetPercent: 50 });
    expect(h.planHistoryRecorder.finalizeForUserChange).toHaveBeenCalledWith('ev-1', NOW_MS, 'abandoned');
    expect(h.activePlanRecorder.clearForDevice).toHaveBeenCalledWith('ev-1');
    expect(h.rebuildPlan).toHaveBeenCalledOnce();
  });

  it('clear is a no-op (no rebuild) when the device has no key at all', () => {
    const store = buildStore();
    const h = buildDeviceDeps(store);
    clearObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway' });
    expect(h.activePlanRecorder.clearForDevice).not.toHaveBeenCalled();
    expect(h.rebuildPlan).not.toHaveBeenCalled();
  });

  it('clear STILL unsets the key when its value reads as undefined (flaky read must not no-op the clear)', () => {
    const store = buildStore();
    store.raw.set(keyFor('ev-1'), undefined); // key present in getKeys, value reads undefined
    const h = buildDeviceDeps(store);
    clearObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway' });
    expect(store.raw.has(keyFor('ev-1'))).toBe(false); // genuinely cleared
    expect(h.rebuildPlan).toHaveBeenCalledOnce();
  });

  it('clear REFUSES on a store-wide empty getKeys() flake (migration unconfirmable → retry, no wrong-place unset)', () => {
    // On an empty getKeys() read the migration can't be confirmed complete, so the
    // device's objective could still live only in an un-migrated blob. Acting (unset
    // of the per-key) would be the wrong place AND a later migration could resurrect
    // it. The write refuses instead; the per-key is left intact and the user retries.
    const store = buildStore({ 'ev-1': evEntry });
    const flaky = { ...store, getKeys: () => [] }; // store-wide getKeys flake
    const h = buildDeviceDeps(flaky);
    const outcome = clearObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway' });
    expect(outcome).toEqual({ persisted: false, reason: 'migration_deferred' });
    expect(store.raw.has(keyFor('ev-1'))).toBe(true); // NOT unset — refused
    expect(h.rebuildPlan).not.toHaveBeenCalled();
  });

  it('upsert REFUSES (no write) when the key exists but its value reads as undefined — never clobber on a flaky read', () => {
    const store = buildStore();
    store.raw.set(keyFor('ev-1'), undefined); // flaky read of an existing key
    const h = buildDeviceDeps(store);
    const outcome = upsertObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway', entry: evEntry });
    expect(outcome).toEqual({ persisted: false, reason: 'untrusted_absence' });
    expect(store.raw.get(keyFor('ev-1'))).toBeUndefined(); // NOT overwritten
    expect(h.rebuildPlan).not.toHaveBeenCalled();
  });

  it('upsert finalizes the prior run as replaced when overwriting an active objective', () => {
    const store = buildStore({ 'ev-1': { ...evEntry, targetPercent: 50 } });
    const h = buildDeviceDeps(store);
    upsertObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway', entry: evEntry });
    expect(h.planHistoryRecorder.finalizeForUserChange).toHaveBeenCalledWith('ev-1', NOW_MS, 'replaced');
    expect(h.activePlanRecorder.markPending).toHaveBeenCalledOnce();
  });

  it('upsert PRESERVES a standing rescue permission on re-create (default preserve policy)', () => {
    const store = buildStore({
      'ev-1': { ...evEntry, targetPercent: 50, rescue: { exemptFromBudget: 'always' } },
    });
    const h = buildDeviceDeps(store);
    // Widget-style re-create: a bare goal/deadline entry with no rescue field.
    upsertObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway', entry: evEntry });
    expect(readObjectiveForDevice(store, 'ev-1')).toEqual({
      ...evEntry,
      rescue: { exemptFromBudget: 'always' },
    });
  });

  it('upsert with rescue:"replace" writes the entry rescue verbatim (clearing it)', () => {
    const store = buildStore({ 'ev-1': { ...evEntry, rescue: { exemptFromBudget: 'always' } } });
    const h = buildDeviceDeps(store);
    upsertObjectiveForDevice(h.deps, {
      deviceId: 'ev-1', deviceName: 'Driveway', entry: evEntry, rescue: 'replace',
    });
    expect(readObjectiveForDevice(store, 'ev-1')).toEqual(evEntry);
    expect(readObjectiveForDevice(store, 'ev-1')!.rescue).toBeUndefined();
  });

  // ── Outcome contract: persisted vs refused (the false-success fix) ──────────

  it('upsert returns { persisted: true } on a successful write', () => {
    const store = buildStore();
    const h = buildDeviceDeps(store);
    const outcome = upsertObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway', entry: evEntry });
    expect(outcome).toEqual({ persisted: true });
  });

  it('clear returns { persisted: true } for a trustworthy-absent no-op', () => {
    const store = buildStore();
    const h = buildDeviceDeps(store);
    const outcome = clearObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway' });
    expect(outcome).toEqual({ persisted: true });
  });

  it('upsert REFUSES with migration_deferred on an empty-getKeys flake (marker unconfirmable)', () => {
    // Empty getKeys() leaves the one-shot migration unable to complete, so the
    // marker stays unset and the write must refuse rather than fork a per-key.
    const store = buildStore({ 'ev-1': evEntry });
    const flaky = { ...store, getKeys: () => [] };
    const h = buildDeviceDeps(flaky);
    const outcome = upsertObjectiveForDevice(h.deps, { deviceId: 'ev-2', deviceName: 'Garage', entry: evEntry });
    expect(outcome).toEqual({ persisted: false, reason: 'migration_deferred' });
    expect(h.rebuildPlan).not.toHaveBeenCalled();
  });

  // ── Refusal observability: a topic-gated `deferred_objectives` debug trace ──
  // so a transient refusal is correlatable server-side, not only visible as the
  // user-facing card error.

  it('upsert emits objective_write_refused on an untrusted-absence refusal', () => {
    const store = buildStore();
    store.raw.set(keyFor('ev-1'), undefined); // flaky read of an existing key
    const h = buildDeviceDeps(store);
    upsertObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway', entry: evEntry });
    expect(h.debugStructured).toHaveBeenCalledWith({
      event: 'objective_write_refused', op: 'upsert', deviceId: 'ev-1', reason: 'untrusted_absence',
    });
  });

  it('clear emits objective_write_refused on a migration-deferred refusal', () => {
    const store = buildStore({ 'ev-1': evEntry });
    const h = buildDeviceDeps({ ...store, getKeys: () => [] });
    clearObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway' });
    expect(h.debugStructured).toHaveBeenCalledWith({
      event: 'objective_write_refused', op: 'clear', deviceId: 'ev-1', reason: 'migration_deferred',
    });
  });

  it('does NOT emit objective_write_refused on a successful write', () => {
    const store = buildStore();
    const h = buildDeviceDeps(store);
    upsertObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway', entry: evEntry });
    expect(h.debugStructured).not.toHaveBeenCalled();
  });
});

