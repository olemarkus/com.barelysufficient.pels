import { describe, expect, it } from 'vitest';
import {
  ELIGIBILITY_ABANDON_GRACE_MS,
  TaskAllocationRoster,
} from '../../lib/objectives/deferredObjectives/taskAllocationRoster';
import type { ObjectiveDeviceInput } from '../../lib/objectives/types';
import { partialDouble } from '../helpers/partialDouble';

const NOW_MS = Date.UTC(2026, 0, 1, 12);
const device = partialDouble<ObjectiveDeviceInput>({ id: 'heater' });
const noExclusion = () => false;
const newRoster = () => new TaskAllocationRoster(() => new Date(NOW_MS));

describe('TaskAllocationRoster', () => {
  it('anchors restart grace once rather than renewing it on a read', () => {
    const roster = newRoster();
    expect(roster.read(NOW_MS).shouldReserveMissingDevice(device.id, true)).toBe(true);
    expect(roster.read(NOW_MS).shouldReserveMissingDevice(device.id, false)).toBe(false);
    expect(roster.read(NOW_MS + ELIGIBILITY_ABANDON_GRACE_MS).shouldReserveMissingDevice(device.id, true)).toBe(false);
    expect(roster.read(NOW_MS + 2 * ELIGIBILITY_ABANDON_GRACE_MS).shouldReserveMissingDevice(device.id, true)).toBe(false);
  });

  it('uses accepted presence when a preview sees absence before the next live update', () => {
    const roster = newRoster();
    const seenAt = NOW_MS + 2 * ELIGIBILITY_ABANDON_GRACE_MS;
    roster.observe([device], seenAt, noExclusion);
    // No live disappearance observation has happened yet.
    expect(roster.read(seenAt + 30_000).shouldReserveMissingDevice(device.id, true)).toBe(true);
    expect(roster.read(seenAt + ELIGIBILITY_ABANDON_GRACE_MS).shouldReserveMissingDevice(device.id, true)).toBe(false);
  });

  it('keeps captured reads stable as the live roster changes', () => {
    const roster = newRoster();
    roster.observe([device], NOW_MS, noExclusion);
    roster.observe([], NOW_MS + 30_000, noExclusion);
    const duringGrace = roster.read(NOW_MS + 30_000);
    roster.observe([], NOW_MS + ELIGIBILITY_ABANDON_GRACE_MS, noExclusion);
    expect(duringGrace.shouldReserveMissingDevice(device.id, true)).toBe(true);
    expect(roster.read(NOW_MS + ELIGIBILITY_ABANDON_GRACE_MS).shouldReserveMissingDevice(device.id, true)).toBe(false);
  });

  it('starts a fresh absence allowance only after the device actually returns', () => {
    const roster = newRoster();
    roster.observe([device], NOW_MS, noExclusion);
    roster.observe([], NOW_MS + ELIGIBILITY_ABANDON_GRACE_MS, noExclusion);
    expect(roster.read(NOW_MS + ELIGIBILITY_ABANDON_GRACE_MS).shouldReserveMissingDevice(device.id, true)).toBe(false);
    const returnedAt = NOW_MS + 2 * ELIGIBILITY_ABANDON_GRACE_MS;
    roster.observe([device], returnedAt, noExclusion);
    roster.observe([], returnedAt + 30_000, noExclusion);
    expect(roster.read(returnedAt + 30_000).shouldReserveMissingDevice(device.id, true)).toBe(true);
  });

  it('forgets removed tasks and excluded devices instead of retaining their old grace', () => {
    const roster = newRoster();
    const seenAt = NOW_MS + ELIGIBILITY_ABANDON_GRACE_MS;
    roster.observe([device], seenAt, noExclusion);
    roster.observe([], seenAt + 30_000, noExclusion);
    roster.retainObjectiveDeviceIds(new Set());
    expect(roster.read(seenAt + 30_000).shouldReserveMissingDevice(device.id, true)).toBe(false);

    roster.observe([device], seenAt + 60_000, noExclusion);
    roster.observe([], seenAt + 90_000, () => true);
    expect(roster.read(seenAt + 90_000).shouldReserveMissingDevice(device.id, true)).toBe(false);
  });
});
