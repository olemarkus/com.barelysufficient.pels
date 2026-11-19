import { describe, expect, it } from 'vitest';
import { HigherRankedLoad, orderDeferredObjectives } from '../../lib/objectives/deferredObjectives/priorityAllocation';
import { resolveHighestObjectiveAdmissionPowerKw } from '../../lib/objectives/deferredObjectives/objectiveSteps';
import type { OrderedDeferredObjective } from '../../lib/objectives/deferredObjectives/priorityAllocation';
import type { ObjectiveDeviceInput } from '../../lib/objectives/types';
import { ModePriorityCatalog } from '../../packages/shared-domain/src/settings/modePriorities';

const device = (id: string, powerKw: number, commandAuthority = true): ObjectiveDeviceInput => ({
  id, name: id, deviceType: 'onoff', isEvCharger: false,
  currentDrawKw: 0, expectedPowerKw: powerKw,
  control: { managed: true, commandAuthority },
  objectiveSessionInactive: false, waitingForCarAssociation: false, thermalDirection: 'heating',
  steppedLoadProfile: { steps: [{ id: 'off', planningPowerW: 0 }, { id: 'on', planningPowerW: powerKw * 1000 }] },
});

const unknownSteps = (id: string, commandAuthority = true): ObjectiveDeviceInput => ({
  ...device(id, 3, commandAuthority), steppedLoadProfile: undefined, steppedLadderMissing: true,
});

const task = (
  deviceId: string,
  higherRankedDeviceIds: readonly string[],
  deviceById: ReadonlyMap<string, ObjectiveDeviceInput>,
): OrderedDeferredObjective => ({
  deviceId,
  device: deviceById.get(deviceId),
  priority: higherRankedDeviceIds.length + 1,
  reservationEligible: true,
  higherRankedDeviceIds,
  objective: {
    enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 2, deadlineAtMs: 32_400_000,
  },
});

// The former per-task computation is intentionally kept independent of the
// incremental cursor: exact equality also pins its addition order.
const previousHigherLoad = (
  entry: OrderedDeferredObjective,
  known: ReadonlySet<string>,
  deviceById: ReadonlyMap<string, ObjectiveDeviceInput>,
) => {
  let higherPriorityUnbookedPowerKw = 0;
  let higherRankedLoadAccountedFor = true;
  for (const id of entry.higherRankedDeviceIds) {
    if (known.has(id)) continue;
    const higher = deviceById.get(id);
    if (higher?.control.commandAuthority === false) continue;
    const power = higher ? resolveHighestObjectiveAdmissionPowerKw(higher) : null;
    if (power === null) higherRankedLoadAccountedFor = false;
    else higherPriorityUnbookedPowerKw += power;
  }
  return { higherPriorityUnbookedPowerKw, higherRankedLoadAccountedFor };
};

const randomGenerator = (seed: number) => {
  let value = seed;
  return (upperBound: number): number => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value % upperBound;
  };
};

describe('incremental higher-ranked load', () => {
  it.each([
    { roster: ['low', 'pending', 'middle', 'high'] },
    { roster: ['middle', 'low', 'high', 'pending'] },
  ])('matches a full scan with roster order $roster', ({ roster }) => {
    const devices = [
      device('low', 4), device('background', 5, false), device('middle', 1.25),
      unknownSteps('unknown'), device('ordinary', 0.75), device('high', 3),
    ];
    const deviceById = new Map(devices.map((entry) => [entry.id, entry]));
    const catalog = new ModePriorityCatalog({ Home: {
      high: 1, ordinary: 2, unknown: 3, middle: 4, background: 5, low: 6,
    } });
    const objectivesByDeviceId = Object.fromEntries(roster.map((id) => [id, task(id, [], deviceById).objective]));
    const ordered = orderDeferredObjectives(
      { objectivesByDeviceId }, deviceById, () => false, { shouldReserveMissingDevice: () => false },
      { version: 2, plansByDeviceId: {} }, (ids) => catalog.getOrder('Home', ids, () => false),
    );
    expect(ordered.map(({ deviceId, reservationEligible }) => [deviceId, reservationEligible]))
      .toEqual([['high', true], ['middle', true], ['low', true], ['pending', false]]);

    const load = new HigherRankedLoad(deviceById);
    const known = new Set<string>();
    const results = ordered.map((entry) => {
      const incremental = load.advance(entry, known);
      expect(incremental).toEqual(previousHigherLoad(entry, known, deviceById));
      if (entry.deviceId === 'high' || entry.deviceId === 'low') known.add(entry.deviceId);
      return incremental;
    });
    expect(results.map(({ higherPriorityUnbookedPowerKw, higherRankedLoadAccountedFor }) => (
      [higherPriorityUnbookedPowerKw, higherRankedLoadAccountedFor]
    ))).toEqual([[0, true], [0.75, false], [2, false], [2, false]]);
  });

  it('keeps exact decimal addition order and the last duplicate device observation', () => {
    const devices = [device('a', 9), device('a', 0.1), device('b', 0.2), device('c', 0.3)];
    const deviceById = new Map(devices.map((entry) => [entry.id, entry]));
    const load = new HigherRankedLoad(deviceById);
    const known = new Set<string>();
    for (const prefix of [[], ['a'], ['a', 'b'], ['a', 'b', 'c']]) {
      const entry = task(`task-${prefix.length}`, prefix, deviceById);
      expect(load.advance(entry, known)).toEqual(previousHigherLoad(entry, known, deviceById));
    }
    expect(load.advance(task('inactive', ['a', 'b', 'c'], deviceById), known)).toEqual({
      higherPriorityUnbookedPowerKw: 0.1 + 0.2 + 0.3,
      higherRankedLoadAccountedFor: true,
    });
  });

  it('uses the current known set when each higher task first enters the prefix', () => {
    const devices = [unknownSteps('suppressed'), unknownSteps('background', false), device('ordinary', 2)];
    const deviceById = new Map(devices.map((entry) => [entry.id, entry]));
    const load = new HigherRankedLoad(deviceById);
    const known = new Set<string>();
    expect(load.advance(task('suppressed', [], deviceById), known)).toEqual({
      higherPriorityUnbookedPowerKw: 0, higherRankedLoadAccountedFor: true,
    });
    known.add('suppressed');
    expect(load.advance(task('background', ['suppressed'], deviceById), known)).toEqual({
      higherPriorityUnbookedPowerKw: 0, higherRankedLoadAccountedFor: true,
    });
    expect(load.advance(task('ordinary', ['suppressed', 'background'], deviceById), known)).toEqual({
      higherPriorityUnbookedPowerKw: 0, higherRankedLoadAccountedFor: true,
    });
    expect(load.advance(task('missing', ['suppressed', 'background', 'ordinary'], deviceById), known)).toEqual({
      higherPriorityUnbookedPowerKw: 2, higherRankedLoadAccountedFor: true,
    });
    expect(load.advance(task('lower', ['suppressed', 'background', 'ordinary', 'missing'], deviceById), known)).toEqual({
      higherPriorityUnbookedPowerKw: 2, higherRankedLoadAccountedFor: false,
    });
  });

  it('matches the full scan for randomized task subsets, duplicate devices and evolving known load', () => {
    for (let seed = 1; seed <= 250; seed += 1) {
      const random = randomGenerator(seed);
      const rankedIds = Array.from({ length: 1 + random(40) }, (_, index) => `device-${index}`);
      const devices = rankedIds.flatMap((id): ObjectiveDeviceInput[] => {
        const kind = random(6);
        if (kind === 0) return [];
        if (kind === 1) return [unknownSteps(id)];
        if (kind === 2) return [unknownSteps(id, false)];
        const powerKw = (1 + random(99)) / 10;
        if (kind === 3) return [device(id, powerKw, false)];
        if (kind === 4) return [device(id, 99), device(id, powerKw)];
        return [{ ...device(id, powerKw), steppedLoadProfile: undefined }];
      });
      const deviceById = new Map(devices.map((entry) => [entry.id, entry]));
      const known = new Set<string>();
      const load = new HigherRankedLoad(deviceById);
      for (const [index, id] of rankedIds.entries()) {
        // Ordinary devices have no task but still enter the higher prefix.
        if (random(3) === 0) continue;
        const entry = task(id, rankedIds.slice(0, index), deviceById);
        expect(load.advance(entry, known), `seed ${seed}, rank ${index}`)
          .toEqual(previousHigherLoad(entry, known, deviceById));
        if (random(2) === 0) known.add(id);
      }
      // Missing tasks outside the reserving roster all have the same full
      // active prefix, even as each task's own known-load outcome is recorded.
      for (const id of ['inactive-a', 'inactive-b', 'inactive-c']) {
        const entry = { ...task(id, rankedIds, deviceById), reservationEligible: false };
        expect(load.advance(entry, known), `seed ${seed}, ${id}`)
          .toEqual(previousHigherLoad(entry, known, deviceById));
        known.add(id);
      }
    }
  });
});
