/** The per-device choice of an integration-derived model or the owner's manual model. */
import type { DevicePowerControlMode, DevicePowerControlModes } from '../../../contracts/src/types';
import { isUnknownRecord } from '../recordGuards';

export type { DevicePowerControlMode, DevicePowerControlModes };

export const isDevicePowerControlModes = (value: unknown): value is DevicePowerControlModes => (
  isUnknownRecord(value) && Object.values(value).every((mode) => mode === 'automatic' || mode === 'manual')
);

export const normalizeDevicePowerControlModes = (value: unknown): DevicePowerControlModes | null => (
  isDevicePowerControlModes(value) ? value : null
);
