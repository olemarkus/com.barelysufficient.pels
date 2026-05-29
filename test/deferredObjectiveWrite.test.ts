import { describe, expect, it, vi } from 'vitest';
import {
  clearObjectiveForDevice,
  mutateDeferredObjectiveSettings,
  upsertObjectiveForDevice,
  type DeferredObjectiveDeviceWriteDeps,
  type DeferredObjectiveSettingsMutationDeps,
} from '../lib/plan/deferredObjectives/objectiveWrite';
import type { DeferredObjectiveActivePlanRecorder } from '../lib/plan/deferredObjectives/activePlanRecorder';
import type { DeferredObjectivePlanHistoryRecorder } from '../lib/plan/deferredObjectives/planHistory';
import type {
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveSettingsV1,
} from '../lib/plan/deferredObjectives/settings';

const NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const DEADLINE_MS = NOW_MS + 6 * 60 * 60 * 1000;

const evEntry: DeferredObjectiveSettingsEntry = {
  enabled: true,
  kind: 'ev_soc',
  enforcement: 'soft',
  targetPercent: 80,
  deadlineAtMs: DEADLINE_MS,
};

const emptySettings = (): DeferredObjectiveSettingsV1 => ({ version: 1, objectivesByDeviceId: {} });

const settingsWith = (
  entries: Record<string, DeferredObjectiveSettingsEntry>,
): DeferredObjectiveSettingsV1 => ({ version: 1, objectivesByDeviceId: entries });

// ─── Hardened mutation primitive ─────────────────────────────────────────────

describe('mutateDeferredObjectiveSettings', () => {
  const buildDeps = (
    read: () => DeferredObjectiveSettingsV1,
    knownLive: string[],
  ): { deps: DeferredObjectiveSettingsMutationDeps; written: DeferredObjectiveSettingsV1[] } => {
    const written: DeferredObjectiveSettingsV1[] = [];
    return {
      written,
      deps: {
        read,
        write: (next) => { written.push(next); },
        knownLiveDeviceIds: () => knownLive,
      },
    };
  };

  it('persists a clean upsert that drops no other device', () => {
    const { deps, written } = buildDeps(() => settingsWith({ 'ev-1': evEntry }), ['ev-1']);
    const persisted = mutateDeferredObjectiveSettings(deps, (current) => ({
      next: settingsWith({ ...current.objectivesByDeviceId, 'ev-2': evEntry }),
      touchedDeviceId: 'ev-2',
    }));
    expect(persisted).toBe(true);
    expect(Object.keys(written[0]!.objectivesByDeviceId).sort()).toEqual(['ev-1', 'ev-2']);
  });

  it('REFUSES a write that would drop another device the read still held', () => {
    // A buggy mutator that returns only the touched device, dropping ev-1.
    const { deps, written } = buildDeps(() => settingsWith({ 'ev-1': evEntry }), ['ev-1']);
    const persisted = mutateDeferredObjectiveSettings(deps, () => ({
      next: settingsWith({ 'ev-2': evEntry }),
      touchedDeviceId: 'ev-2',
    }));
    expect(persisted).toBe(false);
    expect(written).toHaveLength(0);
  });

  it('REFUSES a clobber from a transient-EMPTY read by reconciling against the recorder', () => {
    // The settings read came back empty (a flaky SDK cycle), but the recorder
    // still believes ev-1 is live. A naive upsert of ev-2 would persist a map
    // holding only ev-2, wiping ev-1. The primitive must refuse.
    const { deps, written } = buildDeps(() => emptySettings(), ['ev-1']);
    const persisted = mutateDeferredObjectiveSettings(deps, (current) => ({
      next: settingsWith({ ...current.objectivesByDeviceId, 'ev-2': evEntry }),
      touchedDeviceId: 'ev-2',
    }));
    expect(persisted).toBe(false);
    expect(written).toHaveLength(0);
  });

  it('persists when the empty read is reconciled and the recorder is also empty', () => {
    const { deps, written } = buildDeps(() => emptySettings(), []);
    const persisted = mutateDeferredObjectiveSettings(deps, (current) => ({
      next: settingsWith({ ...current.objectivesByDeviceId, 'ev-2': evEntry }),
      touchedDeviceId: 'ev-2',
    }));
    expect(persisted).toBe(true);
    expect(Object.keys(written[0]!.objectivesByDeviceId)).toEqual(['ev-2']);
  });

  it('allows clearing the touched device even though it disappears from the map', () => {
    const { deps, written } = buildDeps(() => settingsWith({ 'ev-1': evEntry }), ['ev-1']);
    const persisted = mutateDeferredObjectiveSettings(deps, () => ({
      next: emptySettings(),
      touchedDeviceId: 'ev-1',
    }));
    expect(persisted).toBe(true);
    expect(written[0]!.objectivesByDeviceId).toEqual({});
  });

  // ── Cold-start double-empty guard (FIX 1) ──────────────────────────────────
  // The dangerous window: a restart whose active-plans boot read AND an early
  // mutation's objectives read BOTH transiently return empty. Both guard arms
  // (`dropsFromRead`, `dropsFromRecorder`) are then blind, so the recorder
  // exposes `liveSetAuthoritative() === false` and the primitive refuses ANY
  // write that would persist that empty/reduced map — not just entry-adding
  // creates, but ALSO clear/disable/no-op writes whose `next` is empty because
  // the touched device was absent from the bad read (P1-a). Persisting any of
  // them would clobber siblings that exist on disk but the flaky read missed.

  it('REFUSES an entry-adding write when the recorder live set is UNCONFIRMED and the read is empty', () => {
    const { deps, written } = buildDeps(() => emptySettings(), []);
    deps.liveSetAuthoritative = () => false;
    const persisted = mutateDeferredObjectiveSettings(deps, (current) => ({
      next: settingsWith({ ...current.objectivesByDeviceId, 'ev-2': evEntry }),
      touchedDeviceId: 'ev-2',
    }));
    expect(persisted).toBe(false);
    expect(written).toHaveLength(0);
  });

  it('REFUSES a clear/no-op write (next === current empty) while UNCONFIRMED and read empty (P1-a)', () => {
    // A clear/disable whose touched device is ABSENT from the bad read returns
    // `next: current` (empty). Persisting that empty map clobbers any sibling
    // that the flaky read missed but is genuinely on disk. The old guard let
    // this through because it added no entries; the categorical guard refuses.
    const { deps, written } = buildDeps(() => emptySettings(), []);
    deps.liveSetAuthoritative = () => false;
    const persisted = mutateDeferredObjectiveSettings(deps, (current) => ({
      next: current, // empty — would clobber an on-disk sibling the read missed
      touchedDeviceId: 'ev-1',
    }));
    expect(persisted).toBe(false);
    expect(written).toHaveLength(0);
  });

  it('REFUSES a disable-style write that reduces an empty read while UNCONFIRMED (P1-a)', () => {
    // Even a "flip enabled flag" mutator that returns an empty map (touched
    // device absent from the bad read) must be refused in the cold-start window.
    const { deps, written } = buildDeps(() => emptySettings(), []);
    deps.liveSetAuthoritative = () => false;
    const persisted = mutateDeferredObjectiveSettings(deps, () => ({
      next: emptySettings(),
      touchedDeviceId: 'ev-1',
    }));
    expect(persisted).toBe(false);
    expect(written).toHaveLength(0);
  });

  it('ALLOWS the write once the recorder live set is authoritative again (self-heal)', () => {
    const { deps, written } = buildDeps(() => emptySettings(), []);
    deps.liveSetAuthoritative = () => true;
    const persisted = mutateDeferredObjectiveSettings(deps, (current) => ({
      next: settingsWith({ ...current.objectivesByDeviceId, 'ev-2': evEntry }),
      touchedDeviceId: 'ev-2',
    }));
    expect(persisted).toBe(true);
    expect(Object.keys(written[0]!.objectivesByDeviceId)).toEqual(['ev-2']);
  });

  it('ALLOWS a clear once the recorder live set is authoritative (genuinely-empty steady state)', () => {
    // Post-confirmation, a legitimate clear that empties the map must still work
    // — the cold-start window does not apply to steady-state writes.
    const { deps, written } = buildDeps(() => settingsWith({ 'ev-1': evEntry }), ['ev-1']);
    deps.liveSetAuthoritative = () => true;
    const persisted = mutateDeferredObjectiveSettings(deps, () => ({
      next: emptySettings(),
      touchedDeviceId: 'ev-1',
    }));
    expect(persisted).toBe(true);
    expect(written[0]!.objectivesByDeviceId).toEqual({});
  });

  it('ALLOWS the write when unconfirmed but the read still HELD entries (read arm is trustworthy)', () => {
    // If the objectives read was NOT empty, the read arm already protects
    // siblings; an unconfirmed recorder must not block a legitimate upsert.
    const { deps, written } = buildDeps(() => settingsWith({ 'ev-1': evEntry }), []);
    deps.liveSetAuthoritative = () => false;
    const persisted = mutateDeferredObjectiveSettings(deps, (current) => ({
      next: settingsWith({ ...current.objectivesByDeviceId, 'ev-2': evEntry }),
      touchedDeviceId: 'ev-2',
    }));
    expect(persisted).toBe(true);
    expect(Object.keys(written[0]!.objectivesByDeviceId).sort()).toEqual(['ev-1', 'ev-2']);
  });
});

// ─── Device-scoped operations ────────────────────────────────────────────────

describe('device-scoped objective ops', () => {
  const buildDeviceDeps = (
    initial: DeferredObjectiveSettingsV1,
    knownLive: string[] = Object.keys(initial.objectivesByDeviceId),
  ) => {
    let stored = initial;
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
      read: () => stored,
      write: (next) => { stored = next; },
      knownLiveDeviceIds: () => knownLive,
      activePlanRecorder,
      planHistoryRecorder,
      rebuildPlan,
      nowMs: NOW_MS,
    };
    return {
      deps,
      activePlanRecorder,
      planHistoryRecorder,
      rebuildPlan,
      get stored() { return stored; },
    };
  };

  it('upsert reuses the read→upsert→write→notify→rebuild path for a fresh create', () => {
    const h = buildDeviceDeps(emptySettings());
    const persisted = upsertObjectiveForDevice(h.deps, {
      deviceId: 'ev-1', deviceName: 'Driveway', entry: evEntry,
    });
    expect(persisted).toBe(true);
    expect(h.stored.objectivesByDeviceId['ev-1']).toEqual(evEntry);
    expect(h.activePlanRecorder.markPending).toHaveBeenCalledOnce();
    expect(h.planHistoryRecorder.finalizeForUserChange).not.toHaveBeenCalled();
    expect(h.activePlanRecorder.flushIfDirty).toHaveBeenCalledOnce();
    expect(h.planHistoryRecorder.flushIfDirty).toHaveBeenCalledOnce();
    expect(h.rebuildPlan).toHaveBeenCalledOnce();
  });

  it('upsert finalizes the prior run as replaced when overwriting an active objective', () => {
    const h = buildDeviceDeps(settingsWith({ 'ev-1': { ...evEntry, targetPercent: 50 } }));
    upsertObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway', entry: evEntry });
    expect(h.planHistoryRecorder.finalizeForUserChange).toHaveBeenCalledWith('ev-1', NOW_MS, 'replaced');
    expect(h.activePlanRecorder.markPending).toHaveBeenCalledOnce();
  });

  it('upsert PRESERVES a standing rescue permission on re-create (Codex P2)', () => {
    const h = buildDeviceDeps(settingsWith({
      'ev-1': { ...evEntry, targetPercent: 50, rescue: { exemptFromBudget: 'always' } },
    }));
    // Widget-style re-create: a bare goal/deadline entry with no rescue field.
    upsertObjectiveForDevice(h.deps, {
      deviceId: 'ev-1', deviceName: 'Driveway', entry: evEntry,
    });
    expect(h.stored.objectivesByDeviceId['ev-1']).toEqual({
      ...evEntry,
      rescue: { exemptFromBudget: 'always' },
    });
  });

  it('upsert with rescue:"replace" writes the entry rescue verbatim (clearing it)', () => {
    const h = buildDeviceDeps(settingsWith({
      'ev-1': { ...evEntry, rescue: { exemptFromBudget: 'always' } },
    }));
    // Authoritative rescue write that clears the permission (rescue omitted).
    upsertObjectiveForDevice(h.deps, {
      deviceId: 'ev-1', deviceName: 'Driveway', entry: evEntry, rescue: 'replace',
    });
    expect(h.stored.objectivesByDeviceId['ev-1']).toEqual(evEntry);
    expect(h.stored.objectivesByDeviceId['ev-1']!.rescue).toBeUndefined();
  });

  it('upsert REFUSES to clobber a sibling task on a transient-empty read (P1 data-loss guard)', () => {
    // Read comes back empty, but the recorder still knows about ev-1.
    let stored: DeferredObjectiveSettingsV1 = emptySettings();
    const activePlanRecorder = {
      markPending: vi.fn(), clearForDevice: vi.fn(), flushIfDirty: vi.fn(),
    } as unknown as DeferredObjectiveActivePlanRecorder;
    const planHistoryRecorder = {
      finalizeForUserChange: vi.fn(), finalizeElapsedDeadline: vi.fn(), flushIfDirty: vi.fn(),
    } as unknown as DeferredObjectivePlanHistoryRecorder;
    const deps: DeferredObjectiveDeviceWriteDeps = {
      read: () => stored,
      write: (next) => { stored = next; },
      knownLiveDeviceIds: () => ['ev-1'],
      activePlanRecorder,
      planHistoryRecorder,
      rebuildPlan: vi.fn(),
      nowMs: NOW_MS,
    };
    const rebuildPlan = deps.rebuildPlan as ReturnType<typeof vi.fn>;
    const persisted = upsertObjectiveForDevice(deps, {
      deviceId: 'ev-2', deviceName: 'Other', entry: evEntry,
    });
    // Write refused — ev-1's task is NOT wiped, and no phantom hero/rebuild is
    // seeded for the objective that never reached settings.
    expect(persisted).toBe(false);
    expect(stored.objectivesByDeviceId).toEqual({});
    expect(activePlanRecorder.markPending).not.toHaveBeenCalled();
    expect(rebuildPlan).not.toHaveBeenCalled();
  });

  it('clear removes the entry, finalizes the prior run as abandoned, and drops the active plan', () => {
    const h = buildDeviceDeps(settingsWith({ 'ev-1': evEntry }));
    const persisted = clearObjectiveForDevice(h.deps, { deviceId: 'ev-1', deviceName: 'Driveway' });
    expect(persisted).toBe(true);
    expect(h.stored.objectivesByDeviceId).toEqual({});
    expect(h.planHistoryRecorder.finalizeForUserChange).toHaveBeenCalledWith('ev-1', NOW_MS, 'abandoned');
    expect(h.activePlanRecorder.clearForDevice).toHaveBeenCalledWith('ev-1');
    expect(h.rebuildPlan).toHaveBeenCalledOnce();
  });
});
