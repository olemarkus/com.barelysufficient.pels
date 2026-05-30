import { describe, expect, it, vi } from 'vitest';
import {
  addBudgetExemptionRescueForDevice,
  clearObjectiveForDevice,
  resolveBudgetExemptionRescueEntry,
  upsertObjectiveForDevice,
  type DeferredObjectiveDeviceWriteDeps,
} from '../lib/plan/deferredObjectives/objectiveWrite';
import {
  PER_DEVICE_OBJECTIVE_KEY_PREFIX,
  readObjectiveForDevice,
  type ObjectiveSettingsStore,
} from '../lib/plan/deferredObjectives/objectiveStore';
import type { DeferredObjectiveActivePlanRecorder } from '../lib/plan/deferredObjectives/activePlanRecorder';
import type { DeferredObjectivePlanHistoryRecorder } from '../lib/plan/deferredObjectives/planHistory';
import type { DeferredObjectiveSettingsEntry } from '../lib/plan/deferredObjectives/settings';
import { DEFERRED_OBJECTIVES_SETTINGS } from '../lib/utils/settingsKeys';

const NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const DEADLINE_MS = NOW_MS + 6 * 60 * 60 * 1000;

const evEntry: DeferredObjectiveSettingsEntry = {
  enabled: true,
  kind: 'ev_soc',
  enforcement: 'soft',
  targetPercent: 80,
  deadlineAtMs: DEADLINE_MS,
};

// The rescue objective the widget would CREATE when no objective exists: the
// device's intended normal target + a near-term deadline + the budget exemption.
const RESCUE_DEADLINE_MS = NOW_MS + 3 * 60 * 60 * 1000;
const rescueTempEntry: DeferredObjectiveSettingsEntry = {
  enabled: true,
  kind: 'temperature',
  enforcement: 'soft',
  targetTemperatureC: 65,
  deadlineAtMs: RESCUE_DEADLINE_MS,
  rescue: { exemptFromBudget: 'always' },
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
    const deps: DeferredObjectiveDeviceWriteDeps = {
      store,
      activePlanRecorder,
      planHistoryRecorder,
      rebuildPlan,
      nowMs: NOW_MS,
    };
    return { deps, activePlanRecorder, planHistoryRecorder, rebuildPlan };
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
    clearObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway' });
    expect(store.raw.has(keyFor('ev-1'))).toBe(true); // NOT unset — refused
    expect(h.rebuildPlan).not.toHaveBeenCalled();
  });

  it('upsert REFUSES (no write) when the key exists but its value reads as undefined — never clobber on a flaky read', () => {
    const store = buildStore();
    store.raw.set(keyFor('ev-1'), undefined); // flaky read of an existing key
    const h = buildDeviceDeps(store);
    upsertObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway', entry: evEntry });
    expect(store.raw.get(keyFor('ev-1'))).toBeUndefined(); // NOT overwritten
    expect(h.rebuildPlan).not.toHaveBeenCalled();
  });

  it('rescue REFUSES (no overwrite) when the key exists but its value reads as undefined', () => {
    const store = buildStore();
    store.raw.set(keyFor('heater-1'), undefined); // flaky read of an existing objective
    const h = buildDeviceDeps(store);
    addBudgetExemptionRescueForDevice(h.deps, {
      deviceId: 'heater-1', deviceName: 'Hot water', rescueEntry: rescueTempEntry,
    });
    // The fresh rescue was NOT written over the (flaky-read) existing objective.
    expect(store.raw.get(keyFor('heater-1'))).toBeUndefined();
    expect(h.rebuildPlan).not.toHaveBeenCalled();
  });

  it('rescue REFUSES on a store-wide empty getKeys() flake, even when the entry exists', () => {
    // The dangerous flake the per-key-presence check alone missed: getKeys() AND
    // the value read both transiently return empty, so the absence looks "real".
    // The trustworthy-absence guard treats an empty key list as unreadable and
    // refuses, so the user's existing objective is not overwritten by a fresh rescue.
    const existing: DeferredObjectiveSettingsEntry = {
      enabled: true, kind: 'temperature', enforcement: 'soft', targetTemperatureC: 70, deadlineAtMs: DEADLINE_MS,
    };
    const store = buildStore({ 'heater-1': existing });
    const flaky = { ...store, getKeys: () => [], get: () => undefined };
    const h = buildDeviceDeps(flaky);
    addBudgetExemptionRescueForDevice(h.deps, {
      deviceId: 'heater-1', deviceName: 'Hot water', rescueEntry: rescueTempEntry,
    });
    expect(store.raw.get(keyFor('heater-1'))).toEqual(existing); // untouched
    expect(h.rebuildPlan).not.toHaveBeenCalled();
  });

  it('PRE-MIGRATION write completes the migration first, MERGING the legacy blob entry (no fork/loss)', () => {
    // The device's objective exists ONLY in the un-migrated legacy blob (marker
    // unset, no per-key). A rescue/upsert that trusted per-key absence here would
    // fork a fresh per-key the absent-only migration then skips, losing the user's
    // original target/deadline. The write must migrate first, then merge.
    const store = buildStore(); // sentinel key, no per-keys, marker unset
    const existing: DeferredObjectiveSettingsEntry = {
      enabled: true, kind: 'temperature', enforcement: 'soft', targetTemperatureC: 70, deadlineAtMs: DEADLINE_MS,
    };
    store.raw.set(DEFERRED_OBJECTIVES_SETTINGS, { version: 1, objectivesByDeviceId: { 'heater-1': existing } });
    const h = buildDeviceDeps(store);
    addBudgetExemptionRescueForDevice(h.deps, {
      deviceId: 'heater-1', deviceName: 'Hot water', rescueEntry: rescueTempEntry,
    });
    // Migrated from the blob, then the exemption merged in — original target/deadline kept.
    expect(readObjectiveForDevice(store, 'heater-1')).toEqual({ ...existing, rescue: { exemptFromBudget: 'always' } });
    expect(store.raw.get(DEFERRED_OBJECTIVES_SETTINGS)).toBeUndefined(); // blob consumed by the migration
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

  // ── MERGE-not-replace rescue (the starvation-rescue widget's lane) ──────────

  it('rescue CREATES the objective when the device has none', () => {
    const store = buildStore();
    const h = buildDeviceDeps(store);
    addBudgetExemptionRescueForDevice(h.deps, {
      deviceId: 'heater-1', deviceName: 'Hot water', rescueEntry: rescueTempEntry,
    });
    expect(readObjectiveForDevice(store, 'heater-1')).toEqual(rescueTempEntry);
    expect(h.activePlanRecorder.markPending).toHaveBeenCalledOnce();
    expect(h.planHistoryRecorder.finalizeForUserChange).not.toHaveBeenCalled();
    expect(h.rebuildPlan).toHaveBeenCalledOnce();
  });

  it('rescue PRESERVES an existing objective\'s target/deadline and only adds the exemption', () => {
    const existing: DeferredObjectiveSettingsEntry = {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 70, // the user's own target — must be kept
      deadlineAtMs: DEADLINE_MS, // the user's own (later) deadline — must be kept
    };
    const store = buildStore({ 'heater-1': existing });
    const h = buildDeviceDeps(store);
    addBudgetExemptionRescueForDevice(h.deps, {
      deviceId: 'heater-1', deviceName: 'Hot water', rescueEntry: rescueTempEntry,
    });
    expect(readObjectiveForDevice(store, 'heater-1')).toEqual({
      ...existing,
      rescue: { exemptFromBudget: 'always' },
    });
    expect(h.planHistoryRecorder.finalizeForUserChange).not.toHaveBeenCalled();
    expect(h.activePlanRecorder.clearForDevice).not.toHaveBeenCalled();
  });

  it('rescue PRESERVES a standing limitLowerPriorityDevices permission, adding the exemption beside it', () => {
    const existing: DeferredObjectiveSettingsEntry = {
      ...evEntry,
      rescue: { limitLowerPriorityDevices: 'at_risk' },
    };
    const store = buildStore({ 'ev-1': existing });
    const h = buildDeviceDeps(store);
    addBudgetExemptionRescueForDevice(h.deps, {
      deviceId: 'ev-1', deviceName: 'Driveway', rescueEntry: rescueTempEntry,
    });
    expect(readObjectiveForDevice(store, 'ev-1')!.rescue).toEqual({
      limitLowerPriorityDevices: 'at_risk',
      exemptFromBudget: 'always',
    });
    expect(readObjectiveForDevice(store, 'ev-1')).toMatchObject({
      kind: 'ev_soc', targetPercent: 80, deadlineAtMs: DEADLINE_MS,
    });
  });

  it('rescue ENABLES a previously-disabled objective (a disabled exemption is ignored by the planner)', () => {
    const existing: DeferredObjectiveSettingsEntry = {
      enabled: false,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 70,
      deadlineAtMs: DEADLINE_MS,
    };
    const store = buildStore({ 'heater-1': existing });
    const h = buildDeviceDeps(store);
    addBudgetExemptionRescueForDevice(h.deps, {
      deviceId: 'heater-1', deviceName: 'Hot water', rescueEntry: rescueTempEntry,
    });
    expect(readObjectiveForDevice(store, 'heater-1')).toEqual({
      ...existing,
      enabled: true,
      rescue: { exemptFromBudget: 'always' },
    });
    // prev disabled ⇒ inactive, next enabled ⇒ active: a fresh run is seeded.
    expect(h.activePlanRecorder.markPending).toHaveBeenCalledOnce();
  });

  it('rescue is a no-op write when the device already carries the exemption', () => {
    const existing: DeferredObjectiveSettingsEntry = {
      ...evEntry,
      rescue: { exemptFromBudget: 'always' },
    };
    const store = buildStore({ 'ev-1': existing });
    const h = buildDeviceDeps(store);
    addBudgetExemptionRescueForDevice(h.deps, {
      deviceId: 'ev-1', deviceName: 'Driveway', rescueEntry: rescueTempEntry,
    });
    expect(readObjectiveForDevice(store, 'ev-1')).toEqual(existing);
    expect(h.planHistoryRecorder.finalizeForUserChange).not.toHaveBeenCalled();
  });

  it('PREVIEW≡PERSIST: the persisted merge equals the shared resolver the preview uses', () => {
    const existing: DeferredObjectiveSettingsEntry = {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 70,
      deadlineAtMs: DEADLINE_MS,
    };
    const store = buildStore({ 'heater-1': existing });
    const h = buildDeviceDeps(store);
    addBudgetExemptionRescueForDevice(h.deps, {
      deviceId: 'heater-1', deviceName: 'Hot water', rescueEntry: rescueTempEntry,
    });
    expect(readObjectiveForDevice(store, 'heater-1'))
      .toEqual(resolveBudgetExemptionRescueEntry(existing, rescueTempEntry));
  });
});

// ─── Shared rescue-merge resolver (preview ≡ persist) ───────────────────────
//
// `resolveBudgetExemptionRescueEntry` is the single source of truth the write
// path (`addBudgetExemptionRescueForDevice`) and the preview path
// (`App.previewStarvationRescuePlan`) both derive `(target, deadline, rescue)`
// from, so the plan/cost the user confirms can never diverge from what persists.
describe('resolveBudgetExemptionRescueEntry', () => {
  it('returns the FRESH rescue entry verbatim when the device has no objective', () => {
    expect(resolveBudgetExemptionRescueEntry(undefined, rescueTempEntry)).toEqual(rescueTempEntry);
  });

  it('PRESERVES an existing objective\'s target/deadline, only adding the exemption + enabling', () => {
    const existing: DeferredObjectiveSettingsEntry = {
      enabled: false, // a disabled task's exemption is ignored by the planner ⇒ force enabled
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 70, // user's own target — kept, NOT the rescue's 65°
      deadlineAtMs: DEADLINE_MS, // user's own deadline — kept, NOT the rescue's +3h
    };
    expect(resolveBudgetExemptionRescueEntry(existing, rescueTempEntry)).toEqual({
      ...existing,
      enabled: true,
      rescue: { exemptFromBudget: 'always' },
    });
  });

  it('PROMOTES an existing at_risk exemption to always and keeps sibling permissions', () => {
    const existing: DeferredObjectiveSettingsEntry = {
      ...evEntry,
      rescue: { exemptFromBudget: 'at_risk', limitLowerPriorityDevices: 'at_risk' },
    };
    const resolved = resolveBudgetExemptionRescueEntry(existing, rescueTempEntry);
    expect(resolved.rescue).toEqual({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'at_risk' });
    expect(resolved).toMatchObject({ kind: 'ev_soc', targetPercent: 80, deadlineAtMs: DEADLINE_MS });
  });
});
