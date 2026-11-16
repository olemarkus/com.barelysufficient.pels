import type { SteppedLoadProfile, SteppedLoadStep } from '../../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../../utils/types';
import type { DeviceAdapter, NativeLevelControl } from '../deviceAdapter';
import { CONNECTED_200_STEPPED_LOAD_PROFILE, CONNECTED_300_STEPPED_LOAD_PROFILE } from '../maxPowerLadders';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

// Høiax water heaters, on the no.hoiax app and on the myUplink app. Both step
// the heating elements through a `max_power_*` capability.
const HOIAX_OWNER_URIS = new Set(['homey:app:no.hoiax']);
const HOIAX_DRIVER_ID_PREFIXES = ['homey:app:no.hoiax:', 'no.hoiax:'] as const;
const HOIAX_DRIVER_IDS = new Set(['homey:app:com.myuplink:hoiax', 'com.myuplink:hoiax']);

// A Høiax heater reports the wattage of each of its two elements. The myUplink
// app publishes them as read-only labels such as "1250W" (heater points 504
// and 503); the no.hoiax app as `HeaterNomPower` and `HeaterNomPower2`.
const ELEMENT_POWER_SETTING_PAIRS = [
  ['status_504', 'status_503'],
  ['HeaterNomPower', 'HeaterNomPower2'],
] as const;
const MAX_ELEMENT_POWER_W = 6000;
const ELEMENT_POWER_TEXT = /^\s*(\d+(?:\.\d+)?)\s*w?\s*$/iu;

const normalizeText = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

function isHoiaxDevice(device: HomeyDeviceLike): boolean {
  if (HOIAX_OWNER_URIS.has(normalizeText(device.ownerUri))) return true;
  const driverId = normalizeText(device.driverId);
  return HOIAX_DRIVER_IDS.has(driverId)
    || HOIAX_DRIVER_ID_PREFIXES.some((prefix) => driverId.startsWith(prefix));
}

function readElementPowerW(value: unknown): number | undefined {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : undefined;
  const match = text === undefined ? null : ELEMENT_POWER_TEXT.exec(text);
  const watts = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  return Number.isFinite(watts) && watts > 0 && watts <= MAX_ELEMENT_POWER_W ? watts : undefined;
}

/**
 * The ladder the heater's own element wattages give: low runs the smaller
 * element, medium the larger, max both. The apps number the two elements
 * differently, so the levels are ordered by wattage rather than by point.
 * Two equal elements give one single-element rung.
 */
function resolveElementLadder(device: HomeyDeviceLike): SteppedLoadProfile | undefined {
  const pair = ELEMENT_POWER_SETTING_PAIRS
    .map(([firstKey, secondKey]) => [
      readElementPowerW(device.settings[firstKey]),
      readElementPowerW(device.settings[secondKey]),
    ] as const)
    .find((watts): watts is readonly [number, number] => watts[0] !== undefined && watts[1] !== undefined);
  if (!pair) return undefined;
  const lowW = Math.min(...pair);
  const mediumW = Math.max(...pair);
  const steps: SteppedLoadStep[] = [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: lowW },
    { id: 'medium', planningPowerW: mediumW },
    { id: 'max', planningPowerW: lowW + mediumW },
  ];
  return { steps: mediumW > lowW ? steps : steps.filter((step) => step.id !== 'medium') };
}

const levelControl = (capabilityId: string, fixedLadder?: SteppedLoadProfile): NativeLevelControl => ({
  capabilityId,
  ladder: (device) => resolveElementLadder(device) ?? fixedLadder,
});

export const hoiaxAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isHoiaxDevice,
  nativeLevelControls: [
    levelControl('max_power_3000', CONNECTED_300_STEPPED_LOAD_PROFILE),
    levelControl('max_power_2000', CONNECTED_200_STEPPED_LOAD_PROFILE),
    levelControl('max_power', CONNECTED_200_STEPPED_LOAD_PROFILE),
    // myUplink's Connected 120 and Connected Retrofit. Their element wattages
    // vary by installation, so they have no fixed ladder.
    levelControl('max_power_2elem'),
  ],
};
