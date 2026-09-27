import { pruneMissingLearnedPeaks } from '../../lib/device/devicePowerPeak';
import type { AppContext } from '../../lib/app/appContext';

/** Bind the device owner’s learned-peak prune operation to the app’s live cache. */
export const pruneMissingLearnedPowerPeaks = (
  ctx: AppContext,
  presentDeviceIds: ReadonlySet<string>,
): void => pruneMissingLearnedPeaks(ctx.lastKnownPowerKw, presentDeviceIds);
