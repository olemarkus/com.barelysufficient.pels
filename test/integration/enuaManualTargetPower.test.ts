import Homey from 'homey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TargetPowerSteppedLoadConfig } from '../../packages/contracts/src/types';
import { getLogger } from '../../lib/logging/logger';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { homeyDevice, setable } from '../helpers/homeyDevicePayload';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';

const ID = 'enua-manual';
const GRID_WATTS_PER_AMP = Math.sqrt(3) * 230;
const SAVED_CONFIGS: { model: string; config: TargetPowerSteppedLoadConfig }[] = [
  { model: 'one-phase preset', config: { enabled: true, preset: 'ev_charger_1_phase' } },
  { model: 'three-phase preset', config: { enabled: true, preset: 'ev_charger_3_phase' } },
  { model: 'continuous range', config: { enabled: true, min: 0, max: 22080, step: 230 } },
];

describe.each(['homey', 'device'] as const)('Enua Manual native target with initial mode %s', (mode) => {
  beforeEach(() => resetMockHomey());
  afterEach(() => {
    setRestClient({
      get: (path) => mockHomeyInstance.api.get(path),
      put: (path, body) => mockHomeyInstance.api.put(path, body),
    });
  });

  it.each(SAVED_CONFIGS)('preserves native commands for the saved $model', async ({ config }) => {
    const device = homeyDevice({
      id: ID, name: 'Enua Charge', class: 'evcharger',
      driverId: 'homey:app:no.enua:enua-charger', ownerUri: 'homey:app:no.enua',
      settings: { grid_type: 'it_3phase' }, available: true,
    }, {
      measure_power: Math.round(16 * GRID_WATTS_PER_AMP),
      target_power: { value: Math.round(16 * GRID_WATTS_PER_AMP), min: 0, max: 22080, step: 230, setable: true },
      target_power_mode: setable(mode),
      evcharger_charging: setable(true),
      evcharger_charging_state: 'plugged_in_charging',
    }, new Date().toISOString());
    const trigger = vi.fn().mockResolvedValue(undefined);
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App,
      { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/enua-manual') }, {
        settings: { getDeviceTargetPowerConfig: () => config },
      }, undefined, { getFlowTriggerCard: () => ({ trigger }) });
    try {
      await initWithLiveFeed(transport);
      const [parsed] = await seedTransportDevices(transport, [device]);
      expect(parsed.automaticPowerControl?.mode).toBe('manual');
      const desiredPowerW = Math.round(10 * GRID_WATTS_PER_AMP);
      const profile = parsed.steppedLoadProfile;
      const step = profile?.steps.find((candidate) => config.preset
        ? candidate.id === '10a' : candidate.planningPowerW === desiredPowerW);
      if (!profile || !step) throw new Error('Expected the saved Manual ladder to contain a 10 A step');
      const put = vi.fn().mockResolvedValue(undefined);
      setRestClient({ get: async () => device, put });

      expect(await transport.requestSteppedLoadStep({
        deviceId: ID, profile, desiredStepId: step.id,
        planningPowerW: step.planningPowerW, planningCurrentA: step.planningCurrentA ?? 0,
      })).toEqual({ requested: true, acknowledged: true, transport: 'native_capability' });
      expect(put.mock.calls).toEqual([
        [`manager/devices/device/${ID}/capability/target_power`, pelsCapabilityWrite(desiredPowerW)],
        ...(mode === 'device'
          ? [[`manager/devices/device/${ID}/capability/target_power_mode`, pelsCapabilityWrite('homey')]] : []),
      ]);
      expect(trigger).not.toHaveBeenCalled();
    } finally {
      transport.destroy();
    }
  });
});
