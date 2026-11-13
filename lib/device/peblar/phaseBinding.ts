import type { ChargingPhaseBinding } from '../deviceAdapter';
import type { HomeyDeviceLike } from '../../utils/types';
import { toCapabilityTimestampMs } from '../managerControl';
import type { ChargingPhasePower } from '../../ports/chargingPhases';

const APP_URI = 'homey:app:com.KyleMichiels.Peblar';
const CURRENT = 'peblar_charge_limit';
export const PEBLAR_PHASE_POWER_IDS = ['peblar_power_l1', 'peblar_power_l2', 'peblar_power_l3'] as const;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function power(device: HomeyDeviceLike, id: string): ChargingPhasePower | undefined {
  const reading = device.capabilitiesObj[id];
  const stamp = toCapabilityTimestampMs(reading?.lastUpdated);
  return finite(reading?.value) && reading.value >= 0 && stamp !== undefined
    ? { watts: reading.value, observedAtMs: stamp } : undefined;
}

/** These published settings acknowledge a command. Only the per-phase watts describe physical draw. */
export const peblarPhaseBinding: ChargingPhaseBinding = {
  appUri: APP_URI,
  read(device) {
    const forceSinglePhase = device.capabilitiesObj.peblar_force_1_phase?.value;
    const forceSinglePhaseObservedAtMs = toCapabilityTimestampMs(
      device.capabilitiesObj.peblar_force_1_phase?.lastUpdated,
    );
    const current = device.capabilitiesObj[CURRENT];
    const currentLimitA = current?.value;
    const maximumCurrentA = current?.max;
    const [a, b, c] = PEBLAR_PHASE_POWER_IDS.map((id) => power(device, id));
    const totalPower = power(device, 'measure_power');
    if (typeof forceSinglePhase !== 'boolean' || forceSinglePhaseObservedAtMs === undefined
      || !finite(currentLimitA) || currentLimitA < 0
      || !finite(maximumCurrentA) || maximumCurrentA < 6 || !a || !b || !c || !totalPower) return undefined;
    return { forceSinglePhase, forceSinglePhaseObservedAtMs, currentLimitA, minimumCurrentA: 6,
      maximumCurrentA: Math.floor(maximumCurrentA), powers: [a, b, c], totalPower };
  },
  profile(device, phases) {
    const current = device.capabilitiesObj[CURRENT];
    if (current?.setable !== true || !finite(current.max)) return undefined;
    const maximum = Math.floor(current.max);
    if (maximum < 6 || maximum > 48) return undefined;
    return { steps: [
      { id: 'off', planningCurrentA: 0, planningPowerW: 0 },
      ...Array.from({ length: maximum - 5 }, (_, index) => {
        const amps = index + 6;
        return { id: `${amps}a`, planningCurrentA: amps, planningPowerW: amps * phases * 230 };
      }),
    ] };
  },
  command(device, command) {
    if (command.kind === 'charging_phase_prepare') {
      return device.capabilitiesObj[CURRENT]?.setable === true
        ? { kind: 'capabilities', writes: [{ capabilityId: CURRENT, value: command.currentA }] }
        : { kind: 'app_action', step: { deviceId: command.deviceId, actionId: 'peblar_set_charge_current',
          args: { amps: command.currentA } } };
    }
    if (device.capabilitiesObj[CURRENT]?.setable === true
      && device.capabilitiesObj.peblar_force_1_phase?.setable === true) {
      return { kind: 'capabilities', writes: command.kind === 'charging_phase'
        ? [{ capabilityId: CURRENT, value: command.currentA },
          { capabilityId: 'peblar_force_1_phase', value: command.phases === 1 }]
        : [{ capabilityId: 'peblar_force_1_phase', value: command.forceSinglePhase }] };
    }
    return { kind: 'app_action', step: command.kind === 'charging_phase'
      ? { deviceId: command.deviceId, actionId: 'set_charge_limit_with_phase',
        args: { amps: command.currentA, phase_mode: command.phases === 1 ? '1f' : '3f' } }
      : { deviceId: command.deviceId, actionId: 'set_force_1_phase',
        args: { enabled: command.forceSinglePhase } } };
  },
};
