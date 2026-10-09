// The home a device-keyed mode-target seed is filed under: the device's
// committed owner, or nothing while ownership is not known.
import { describe, expect, it } from 'vitest';
import { resolveHomeIdForModeCatalogSeed } from '../../lib/home/homeModeDeviceRead';
import type { HomeMembershipPort } from '../../lib/home/membership';
import { partialDouble } from '../helpers/partialDouble';

const membership = (ready: boolean, pendingGeneration: boolean): HomeMembershipPort => (
  partialDouble<HomeMembershipPort>({
    isOwnershipReady: () => ready,
    hasPendingOwnershipGeneration: () => pendingGeneration,
    getHomeIdForDevice: () => 'h_area',
  })
);

describe('resolveHomeIdForModeCatalogSeed', () => {
  it('files the seed under the device\'s settled home', () => {
    expect(resolveHomeIdForModeCatalogSeed(membership(true, false), 'dev-1')).toBe('h_area');
  });

  it('seeds nothing while ownership is unsettled', () => {
    expect(resolveHomeIdForModeCatalogSeed(membership(false, false), 'dev-1')).toBeNull();
    expect(resolveHomeIdForModeCatalogSeed(membership(true, true), 'dev-1')).toBeNull();
  });

  it('seeds nothing with no membership, rather than guessing Main', () => {
    // Boot before `initHomeMembership`, or after `runUninit` cleared it.
    expect(resolveHomeIdForModeCatalogSeed(undefined, 'dev-1')).toBeNull();
  });
});
