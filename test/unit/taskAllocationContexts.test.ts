import type { DeferredObjectiveActivePlansV2 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveSettingsEntry } from '../../packages/contracts/src/deferredObjectiveSettings';
import { buildObjectiveSignatureForEntry } from '../../lib/objectives/deferredObjectives/activePlanSignature';
import {
  withTaskAllocationContexts, type OrderedDeferredObjective,
} from '../../lib/objectives/deferredObjectives/priorityAllocation';
import { resolveObjectiveProgressDirectionRead, type ObjectiveDeviceInput } from '../../lib/objectives/types';
import { partialDouble } from '../helpers/partialDouble';

// The previous full-prefix serialization is deliberately independent of the
// incremental implementation: these strings are persisted compatibility keys.
const oldRosterSignature = (entries: readonly OrderedDeferredObjective[]): string => JSON.stringify(
  entries.map((entry) => [entry.deviceId, entry.priority, buildObjectiveSignatureForEntry(
    entry.objective,
    resolveObjectiveProgressDirectionRead({
      objectiveKind: entry.objective.kind, thermalDirection: entry.device?.thermalDirection ?? 'unknown',
    }),
  )]),
);
const oldPlanningContext = (
  prefix: readonly OrderedDeferredObjective[], plans: DeferredObjectiveActivePlansV2,
): string => JSON.stringify([
  oldRosterSignature(prefix),
  prefix.slice(0, -1).map(({ deviceId }) => {
    const plan = plans.plansByDeviceId[deviceId];
    return [deviceId, plan?.objectiveSignature, plan?.latest?.revision, plan?.latest?.revisedAtMs];
  }),
]);

it('preserves empty allocation contexts', () => {
  const plans: DeferredObjectiveActivePlansV2 = { version: 2, plansByDeviceId: {} };
  expect(withTaskAllocationContexts([], plans)).toEqual([]);
});

it('preserves every persisted prefix byte for randomized task and revision sets', () => {
  let seed = 0x3127;
  const random = (bound: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % bound;
  };
  const escaped = ['plain', 'quote"', 'back\\slash', 'line\nfeed', 'tab\t', 'surrogate\ud800', 'unicode🌡'];
  for (let trial = 0; trial < 160; trial += 1) {
    const ordered = Array.from({ length: 1 + random(35) }, (_, index): OrderedDeferredObjective => {
      const deviceId = `${index}-${escaped[random(escaped.length)]}`;
      const common = { enabled: true, enforcement: 'soft' as const, deadlineAtMs: 1_800_000_000_000 + random(100000) };
      const kind = random(3);
      let objective: DeferredObjectiveSettingsEntry;
      if (kind === 0) {
        objective = { ...common, kind: 'energy', targetEnergyKWh: random(100) / 10 + 0.1 };
      } else if (kind === 1) {
        objective = { ...common, kind: 'temperature', targetTemperatureC: random(50) + 20 };
      } else {
        objective = { ...common, kind: 'ev_soc', targetPercent: random(99) + 1 };
      }
      const direction = (['heating', 'cooling'] as const)[random(2)];
      return {
        deviceId, priority: index + 1, objective, reservationEligible: random(2) === 0,
        higherRankedDeviceIds: [],
        ...(random(3) === 0 ? {} : { device: partialDouble<ObjectiveDeviceInput>({
          id: deviceId, thermalDirection: direction,
        }) }),
      };
    });
    const plans: DeferredObjectiveActivePlansV2 = {
      version: 2,
      plansByDeviceId: Object.fromEntries(ordered.flatMap((task) => {
        if (random(3) === 0) return [];
        return [[task.deviceId, partialDouble<DeferredObjectiveActivePlansV2['plansByDeviceId'][string]>({
          objectiveSignature: `${escaped[random(escaped.length)]}-${random(20)}`,
          ...(random(4) === 0 ? {} : { latest: partialDouble<
            DeferredObjectiveActivePlansV2['plansByDeviceId'][string]['latest']
          >({ revision: random(500), revisedAtMs: 1_800_000_000_000 + random(50000) }) }),
        })]];
      })),
    };
    withTaskAllocationContexts(ordered, plans).forEach((task, index) => {
      const prefix = ordered.slice(0, index + 1);
      expect(task.rosterSignature).toBe(oldRosterSignature(prefix));
      expect(task.planningContextSignature).toBe(oldPlanningContext(prefix, plans));
    });
  }
});
