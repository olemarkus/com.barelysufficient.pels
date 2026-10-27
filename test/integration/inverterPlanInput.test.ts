import { describe, expect, it } from 'vitest';
import { readInverterPlanInputs, type InverterPlanInputSource } from '../../lib/planInput/inverterPlanInput';
import { InverterCurtailmentPlanner } from '../../lib/plan/inverterCurtailment';
import type { DeviceConfigurationRead } from '../../lib/ports/deviceConfigurationRead';
import type { InverterClaim } from '../../lib/ports/inverterControl';
import type { HomeMembershipPort } from '../../lib/home/membership';
import type { ProjectedObservedDeviceState } from '../../packages/contracts/src/types';
import type { InverterControlSurface, InverterObservation } from '../../packages/contracts/src/inverterControl';
import { partialDouble } from '../helpers/partialDouble';

const surface: InverterControlSurface = { maxW: 6000, stepW: 1, mode: 'direct', authority: 'limit_and_release' };
const observation: InverterObservation = {
  production: { value: 1000, observedAtMs: 1000 }, limit: { value: 1000, observedAtMs: 1000 }, mode: { kind: 'direct' },
};
const claim: InverterClaim = {
  previousLimitW: 6000, previousMode: { kind: 'direct' }, claimedAtMs: 0,
  restoration: { kind: 'native', binding: surface },
};

describe('inverter input hand-back eligibility', () => {
  const source = (): InverterPlanInputSource => ({
    configurations: () => [partialDouble<DeviceConfigurationRead>({ id: 'pv', inverterControl: surface })],
    observed: () => partialDouble<ProjectedObservedDeviceState>({ available: true, inverterObservation: observation }),
    selected: () => ({ pv: true }), simulation: () => false,
    membership: () => partialDouble<HomeMembershipPort>({ filterDevicesForHome: (devices) => [...devices] }),
    execution: {
      heldDeviceIds: () => ['pv'], ready: () => true, ownership: () => ({ kind: 'held', claim, recovering: false }), notBeforeMs: () => 0,
    },
  });

  it.each(['missing control', 'retained control', 'unavailable', 'missing observation', 'changed range'] as const)(
    'releases a held inverter with %s during negative-price export', (scenario) => {
      const h = source();
      if (scenario === 'missing control') h.configurations = () => [partialDouble<DeviceConfigurationRead>({ id: 'pv' })];
      if (scenario === 'retained control') h.configurations = () => [partialDouble<DeviceConfigurationRead>({
        id: 'pv', inverterControl: { ...surface, authority: 'release_only' },
      })];
      if (scenario === 'changed range') h.configurations = () => [partialDouble<DeviceConfigurationRead>({
        id: 'pv', inverterControl: { ...surface, maxW: 7000 },
      })];
      if (scenario === 'unavailable') h.observed = () => partialDouble<ProjectedObservedDeviceState>({
        available: false, inverterObservation: observation,
      });
      if (scenario === 'missing observation') h.observed = () => undefined;
      const inputs = readInverterPlanInputs(h);
      expect(inputs).toEqual([{ kind: 'hand_back', deviceId: 'pv' }]);
      const planner = new InverterCurtailmentPlanner({ inputs: () => inputs, exportCostly: () => true });
      expect(planner.decide(-3000, 10_000)).toEqual([{ kind: 'release', deviceId: 'pv' }]);
      expect(planner.releaseAll()).toEqual([{ kind: 'release', deviceId: 'pv' }]);
    },
  );

  it('does not admit a new cap without accepted controls, and never deletes a claim for an absent device', () => {
    const h = source();
    h.configurations = () => [partialDouble<DeviceConfigurationRead>({ id: 'pv' })];
    h.execution.ownership = () => ({ kind: 'free' });
    h.execution.heldDeviceIds = () => [];
    expect(readInverterPlanInputs(h)).toEqual([]);
    h.configurations = () => [];
    h.execution.ownership = () => ({ kind: 'held', claim, recovering: true });
    h.execution.heldDeviceIds = () => ['pv'];
    expect(readInverterPlanInputs(h)).toEqual([{ kind: 'hand_back', deviceId: 'pv' }]);
  });
});
