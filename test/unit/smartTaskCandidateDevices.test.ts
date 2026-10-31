import { describe, expect, it } from 'vitest';
import type { CreateSmartTaskCandidateDevice } from '../../packages/contracts/src/widgetHostApi';
import { buildSmartTaskCandidateDevices } from '../../lib/objectives/deferredObjectives/smartTaskCandidateDevices';
import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';

const charger: CreateSmartTaskCandidateDevice = {
  id: 'charger', name: 'Charger', available: true, targets: [], binaryControl: { on: false },
  isEvCharger: true, binaryControllable: true, evChargingState: 'plugged_in',
  measuredPowerKw: 0, measuredPowerIsDirectMeasurement: true,
};

describe('smart task candidate goals', () => {
  it('offers a battery goal alongside the plugged-in charger’s default energy goal', () => {
    expect(buildSmartTaskCandidateDevices([charger])).toMatchObject([{
      deviceId: 'charger', kind: 'energy', unitSymbol: 'kWh', goalMin: 0.1, goalMax: 200,
      otherGoals: [{ kind: 'ev_soc', unitSymbol: '%', goalMin: 1, goalMax: 100, goalStep: 1 }],
    }]);
  });

  it.each([
    { transition: 'unplugs', device: { ...charger, evChargingState: 'plugged_out' as const } },
    { transition: 'reports its battery level', device: {
      ...charger, stateOfCharge: stateOfChargeFixture({ percent: 40 }),
    } },
  ])('keeps energy support and its own bounds when the charger $transition', ({ device }) => {
    expect(buildSmartTaskCandidateDevices([device])).toMatchObject([{
      deviceId: 'charger', kind: 'ev_soc', unitSymbol: '%', goalMin: 1, goalMax: 100,
      otherGoals: [{ kind: 'energy', unitSymbol: 'kWh', goalMin: 0.1, goalMax: 200, goalStep: 0.1 }],
    }]);
  });

  it('does not offer an energy goal without a direct power observation', () => {
    const unmetered = { ...charger };
    delete unmetered.measuredPowerKw;
    const derived = { ...charger, measuredPowerIsDirectMeasurement: false };
    for (const device of [unmetered, derived]) {
      expect(buildSmartTaskCandidateDevices([device])).toMatchObject([{
        deviceId: 'charger', kind: 'ev_soc', otherGoals: [],
      }]);
    }
  });
});
