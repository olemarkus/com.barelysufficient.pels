import type { SteppedLoadProfile } from '../../../packages/contracts/src/types';
import { TARGET_POWER_MAX_GENERATED_STEPS } from '../../../packages/shared-domain/src/targetPowerLadder';
import type { DeviceCapabilityMap } from '../managerControl';
import type { HomeyDeviceLike } from '../../utils/types';
import { EASEE_CHARGER_CURRENT_CAPABILITY_ID, EASEE_MIN_CHARGING_CURRENT_A } from './current';

/** Easee publishes decoded grid/phase settings; current commands remain amps. */
function resolveWattsPerAmp(settings: HomeyDeviceLike['settings']): number | undefined {
  if (settings?.phaseMode === 'Locked to single phase') return 230;
  const grid = settings?.detectedPowerGridType;
  if (typeof grid !== 'string') return undefined;
  if (/_1_PHASE(?:_|$)/u.test(grid)) return 230;
  if (grid === 'TN_3_PHASE') return 3 * 230;
  if (grid === 'IT_3_PHASE') return Math.sqrt(3) * 230;
  return undefined;
}

function positiveSetting(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : undefined;
}

function resolveCurrentMaximum(device: HomeyDeviceLike, declaredMax: number): number | undefined {
  let maximum = declaredMax;
  for (const key of ['maxChargerCurrent', 'circuitFuse']) {
    const raw = device.settings?.[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const limit = positiveSetting(raw);
    if (limit === undefined) return undefined;
    maximum = Math.min(maximum, limit);
  }
  return maximum;
}

export function resolveEaseeAutomaticProfile(
  device: HomeyDeviceLike, values: DeviceCapabilityMap,
): SteppedLoadProfile | undefined {
  const wattsPerAmp = resolveWattsPerAmp(device.settings);
  const current = values[EASEE_CHARGER_CURRENT_CAPABILITY_ID];
  const declaredMax = positiveSetting(current?.max);
  if (wattsPerAmp === undefined || declaredMax === undefined || current?.setable !== true) return undefined;
  if (typeof current.min === 'number' && current.min > 0) return undefined;
  const maximum = resolveCurrentMaximum(device, declaredMax);
  if (maximum === undefined) return undefined;
  const max = Math.floor(maximum);
  const step = current.step === undefined ? 1 : positiveSetting(current.step);
  if (step === undefined || !Number.isInteger(step)) return undefined;
  const minimum = Math.ceil(EASEE_MIN_CHARGING_CURRENT_A / step) * step;
  const count = Math.floor((max - minimum) / step) + 1;
  if (count < 1 || count > TARGET_POWER_MAX_GENERATED_STEPS) return undefined;
  return { steps: [
    { id: 'off', planningPowerW: 0, planningCurrentA: 0 },
    ...Array.from({ length: count }, (_, index) => {
      const amps = minimum + index * step;
      return { id: `${amps}a`, planningPowerW: Math.round(amps * wattsPerAmp), planningCurrentA: amps };
    }),
  ] };
}
