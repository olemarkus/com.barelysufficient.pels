/**
 * Coverage for `evictMissingDeviceCacheEntries` — the per-plan-cycle sweep
 * that keeps the producer-owned per-device caches
 * (`lastKnownCommandableByDevice`, `lastKnownPowerKw`) bounded by dropping
 * entries whose device IDs are no longer present in the latest snapshot.
 *
 * Without this sweep, removing a device from Homey at runtime leaks the
 * entry forever. Source: chunk-2 producer review of PR #1189.
 */
import { describe, expect, it } from 'vitest';
import { evictMissingDeviceCacheEntries } from '../lib/app/appInit';
import { createAppContextMock } from './helpers/appContextTestHelpers';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';

const buildSnapshot = (id: string): TargetDeviceSnapshot => ({
  id,
  name: id,
  targets: [],
} as unknown as TargetDeviceSnapshot);

describe('evictMissingDeviceCacheEntries', () => {
  it('drops lastKnownCommandableByDevice entries whose ids are not in the snapshot', () => {
    const ctx = createAppContextMock();
    // Seed two entries — one survives in the snapshot, one is orphaned.
    ctx.lastKnownCommandableByDevice['present-1'] = {
      commandableNow: true,
      observedAtMs: 1_000,
    };
    ctx.lastKnownCommandableByDevice['orphan-1'] = {
      commandableNow: false,
      observedAtMs: 2_000,
    };

    evictMissingDeviceCacheEntries(ctx, [buildSnapshot('present-1')]);

    expect(ctx.lastKnownCommandableByDevice['present-1']).toEqual({
      commandableNow: true,
      observedAtMs: 1_000,
    });
    expect(ctx.lastKnownCommandableByDevice['orphan-1']).toBeUndefined();
  });

  it('drops lastKnownPowerKw entries whose ids are not in the snapshot', () => {
    const ctx = createAppContextMock();
    ctx.lastKnownPowerKw['present-1'] = 1.23;
    ctx.lastKnownPowerKw['orphan-1'] = 4.56;

    evictMissingDeviceCacheEntries(ctx, [buildSnapshot('present-1')]);

    expect(ctx.lastKnownPowerKw['present-1']).toBe(1.23);
    expect(ctx.lastKnownPowerKw['orphan-1']).toBeUndefined();
  });

  it('is a no-op when every cached id is present in the snapshot', () => {
    const ctx = createAppContextMock();
    ctx.lastKnownCommandableByDevice['a'] = { commandableNow: true, observedAtMs: 0 };
    ctx.lastKnownCommandableByDevice['b'] = { commandableNow: false, observedAtMs: 0 };
    ctx.lastKnownPowerKw['a'] = 1;
    ctx.lastKnownPowerKw['b'] = 2;

    evictMissingDeviceCacheEntries(ctx, [buildSnapshot('a'), buildSnapshot('b')]);

    expect(Object.keys(ctx.lastKnownCommandableByDevice).sort()).toEqual(['a', 'b']);
    expect(Object.keys(ctx.lastKnownPowerKw).sort()).toEqual(['a', 'b']);
  });

  it('clears every cached id when the snapshot is empty', () => {
    // After a device wipe, the snapshot is [] and both caches must drain.
    const ctx = createAppContextMock();
    ctx.lastKnownCommandableByDevice['x'] = { commandableNow: true, observedAtMs: 0 };
    ctx.lastKnownPowerKw['x'] = 9.9;

    evictMissingDeviceCacheEntries(ctx, []);

    expect(ctx.lastKnownCommandableByDevice['x']).toBeUndefined();
    expect(ctx.lastKnownPowerKw['x']).toBeUndefined();
  });
});
