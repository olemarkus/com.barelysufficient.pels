import { describe, expect, it, vi } from 'vitest';
import { toPlanDevice } from '../../setup/appInit';
import { buildExecutableDeviceIntent } from '../../lib/plan/planExecutionProjection';
import { hasTargetPowerClaim } from '../../lib/planContract/executionPlan';
import { applyTargetPowerClaim } from '../../lib/executor/targetPowerClaim';
import type { ActuatorOutcome, DeviceCommand } from '../../lib/actuator/deviceCommand';
import { TargetPowerControlClaims } from '../../lib/device/targetPowerControlClaims';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import type {
  DecoratedDeviceSnapshot, EvObservedProbe, MeasuredPowerObservedProbe,
} from '../../packages/contracts/src/types';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { createTestExecutorCommandContext } from '../helpers/executorCommandContext';
import { buildZaptecTargetPowerDevice } from '../helpers/zaptecDeviceFixture';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { steppedPlanDevice, withDeviceConfiguration } from '../utils/planTestUtils';

const charger = {
  available: true, id: 'charger', name: 'Charger', targets: [], deviceClass: 'evcharger', deviceType: 'onoff',
  isEvCharger: true, isBatteryOrSolar: false, binaryControllable: true, managed: true,
  expectedPowerKw: 7, expectedPowerSource: 'default', controlModel: 'stepped_load',
  steppedLoadProfile: { steps: [{ id: 'off', planningPowerW: 0 }, { id: '2530w', planningPowerW: 2530 }] },
  selectedStepId: '2530w', planningPowerKw: 2.53, measuredPowerKw: 0, evChargingState: 'plugged_out',
} satisfies DecoratedDeviceSnapshot & MeasuredPowerObservedProbe & EvObservedProbe;

const planInput = (managed: boolean, powerLimit: boolean, claim: 'needed' | 'refused' | undefined) => {
  const ctx = createAppContextMock();
  ctx.resolveManagedState = vi.fn(() => managed);
  ctx.isCapacityControlEnabled = vi.fn(() => powerLimit);
  if (!ctx.deviceManager) throw new Error('missing fixture device manager');
  ctx.deviceManager.getTargetPowerControlClaim = () => claim;
  return toPlanDevice(ctx, withDeviceConfiguration(charger));
};

describe("claiming Homey's control of a managed device's watt target", () => {
  it.each([
    ['managed with Power-limit control', true, true],
    ['managed without Power-limit control, for a smart task to claim', true, false],
  ] as const)('reads the watt target as claimable on a device %s', (_case, managed, powerLimit) => {
    expect(planInput(managed, powerLimit, 'needed').targetPowerClaimNeeded).toBe(true);
  });

  it.each([
    ['is not managed', false, 'needed'],
    ['already has Homey in control', true, undefined],
    ['refused the claim until its retry is due', true, 'refused'],
  ] as const)('plans no claim for a device that %s', (_case, managed, claim) => {
    expect('targetPowerClaimNeeded' in planInput(managed, true, claim)).toBe(false);
  });

  it('does not claim a device PELS only watches', () => {
    expect(hasTargetPowerClaim(buildExecutableDeviceIntent(steppedPlanDevice({
      id: 'charger', targetPowerClaimNeeded: true, control: { managed: true, commandAuthority: false },
    })))).toBe(false);
  });

  it.each([
    ['unplugged and left alone', { plannedState: 'inactive' as const, commandableNow: false }],
    ['kept at its step', {}],
  ])('claims a device the plan has %s, with no watt target', (_case, overrides) => {
    const commands = buildExecutableDeviceIntent(steppedPlanDevice({
      id: 'charger', name: 'Charger', targetPowerClaimNeeded: true, ...overrides,
    }));
    if (!hasTargetPowerClaim(commands)) throw new Error('Expected a planned claim');
    expect(commands.targetPowerClaim).toEqual({ deviceId: 'charger', name: 'Charger' });
  });

  it('plans no claim without the need', () => {
    expect(hasTargetPowerClaim(buildExecutableDeviceIntent(steppedPlanDevice({ id: 'charger' })))).toBe(false);
  });

  const execute = async (outcome: ActuatorOutcome | Error, dryRun = false) => {
    const apply = vi.fn(async (_command: DeviceCommand): Promise<ActuatorOutcome> => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    const context = createTestExecutorCommandContext(createPlanEngineState(), {
      getCapacityDryRun: () => dryRun,
      actuator: { canTurnOnDevice: () => true, resolveTemperatureTarget: (_id, desired) => desired, apply },
    });
    return { sent: await applyTargetPowerClaim(context, { deviceId: 'charger', name: 'Charger' }), apply };
  };

  it('sends the claim through the actuator', async () => {
    const { sent, apply } = await execute({ requested: true, kind: 'target_power_claim' });
    expect(sent).toBe(true);
    expect(apply).toHaveBeenCalledExactlyOnceWith({ kind: 'target_power_claim', deviceId: 'charger' });
  });

  it('sends nothing in simulation', async () => {
    const { sent, apply } = await execute({ requested: true, kind: 'target_power_claim' }, true);
    expect(sent).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    ['is refused', { requested: false, reason: 'target_power_claim_refused', errorMessage: 'no' } as const],
    ['fails', new Error('Socket closed')],
  ])('leaves the rest of the device\'s commands to run when the claim %s', async (_case, outcome) => {
    await expect(execute(outcome)).resolves.toMatchObject({ sent: false });
  });
});

describe('which devices have a watt target to claim', () => {
  const claims = new TargetPowerControlClaims();
  const base = buildZaptecTargetPowerDevice();
  const device = (overrides: Partial<HomeyDeviceLike>): HomeyDeviceLike => ({ ...base, ...overrides });

  it('claims a charger whose mode Homey can set', () => {
    expect(claims.resolve(base, 0)).toBe('needed');
  });

  it.each(['battery', 'solarpanel'])('leaves a %s to its own owner', (deviceClass) => {
    expect(claims.resolve(device({ class: deviceClass }), 0)).toBeUndefined();
  });

  it('leaves a device whose mode cannot be set', () => {
    expect(claims.resolve(device({ capabilitiesObj: {
      ...base.capabilitiesObj,
      target_power_mode: { ...base.capabilitiesObj.target_power_mode, setable: false },
    } }), 0)).toBeUndefined();
  });

  it('reads an app that reports homey and puts its own mode back within the landing window as a refusal', () => {
    const claimsForDevice = new TargetPowerControlClaims();
    const homey = device({ capabilitiesObj: {
      ...base.capabilitiesObj,
      target_power_mode: { ...base.capabilitiesObj.target_power_mode, value: 'homey' },
    } });
    claimsForDevice.noteAccepted(base.id, 0);
    expect(claimsForDevice.resolve(homey, 10_000)).toBe('held');
    expect(claimsForDevice.resolve(base, 30_000)).toBe('held');
    expect(claimsForDevice.resolve(base, 6 * 60_000)).toBe('refused');
  });

  it('forgets a claim once the device has held homey past the landing window', () => {
    const claimsForDevice = new TargetPowerControlClaims();
    const homey = device({ capabilitiesObj: {
      ...base.capabilitiesObj,
      target_power_mode: { ...base.capabilitiesObj.target_power_mode, value: 'homey' },
    } });
    claimsForDevice.noteAccepted(base.id, 0);
    expect(claimsForDevice.resolve(homey, 6 * 60_000)).toBe('held');
    // A later change of mode is a new claim, not a refusal of the old one.
    expect(claimsForDevice.resolve(base, 6 * 60_000 + 10_000)).toBe('needed');
  });

  it('leaves a device with no watt mode', () => {
    expect(claims.resolve(device({
      capabilities: base.capabilities.filter((id) => id !== 'target_power_mode'),
    }), 0)).toBeUndefined();
  });
});
