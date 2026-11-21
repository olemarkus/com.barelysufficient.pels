import type { PlanInputDevice } from '../plan/planTypes';
import { projectTemperatureDeniedDevice } from './temperatureControlDenial';
import { resolvePlanInputDeviceFacts } from './resolvePlanInputDeviceFacts';
import { assemblePlanInputDevice } from './assemblePlanInputDevice';
import type {
  PlanInputProjectionSource,
  ToPlanDeviceInput,
  ToPlanDeviceOptions,
  UnrankedPlanInputDevice,
} from './planInputDeviceTypes';

export type {
  PlanInputProjectionSource,
  ToPlanDeviceInput,
  ToPlanDeviceOptions,
  UnrankedPlanInputDevice,
} from './planInputDeviceTypes';

/** Main-home projection policy; sub-homes provide their capacity-only policy. */
export const createDefaultToPlanDeviceOptions = (): ToPlanDeviceOptions => ({
  surplusPostureEnabled: true,
  // The default serves the settings passes, which plan nothing: no lever.
  storage: { kind: 'none' },
  projectCommandability: ({ base }) => ({ commandableNow: base, reason: 'none' }),
});

/**
 * Projects runtime configuration and accepted observation into resolved planner
 * input. The projector receives narrow owner reads, never AppContext or inventory
 * metadata; see `lib/planInput/AGENTS.md`.
 */
export const projectPlanInputDevice = (
  source: PlanInputProjectionSource,
  rawDevice: ToPlanDeviceInput,
  options: ToPlanDeviceOptions,
): UnrankedPlanInputDevice => {
  const device = projectTemperatureDeniedDevice(rawDevice);
  const facts = resolvePlanInputDeviceFacts(source, device, options);
  return assemblePlanInputDevice(rawDevice, device, facts);
};

/** Join this home's executor outcome after the home-scoped device set is known. */
export const withRelayShedDelivery = (
  devices: PlanInputDevice[], read: (id: string) => PlanInputDevice['relayShedNoAck'],
): PlanInputDevice[] => devices.map((device) => {
  const relayShedNoAck = read(device.id);
  return relayShedNoAck ? { ...device, relayShedNoAck } : device;
});
