import type { AppContext } from '../../lib/app/appContext';
import { createDefaultToPlanDeviceOptions, projectPlanInputDevice } from '../../lib/planInput/projectPlanInputDevice';
import type {
  ToPlanDeviceInput,
  ToPlanDeviceOptions,
  UnrankedPlanInputDevice,
} from '../../lib/planInput/projectPlanInputDevice';
import { createPlanInputProjectionSource } from './planInputDeviceProjection';

/** Compatibility adapter for setup callers that project a single plan device. */
export const toPlanDevice = (
  ctx: AppContext,
  device: ToPlanDeviceInput,
  options: ToPlanDeviceOptions = createDefaultToPlanDeviceOptions(),
): UnrankedPlanInputDevice => projectPlanInputDevice(
  createPlanInputProjectionSource(ctx),
  device,
  options,
);

export type {
  ToPlanDeviceInput,
  ToPlanDeviceOptions,
  UnrankedPlanInputDevice,
} from '../../lib/planInput/projectPlanInputDevice';
