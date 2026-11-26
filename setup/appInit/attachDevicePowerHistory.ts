import type { AppContext } from '../../lib/app/appContext';
import { DevicePowerHistoryImporter } from '../../lib/device/devicePowerHistoryImporter';
import { createHomeyWebApiGet } from '../homeyWebApi';

export const attachDevicePowerHistory = (ctx: AppContext): (() => void) => (
  new DevicePowerHistoryImporter(
    ctx.homey.settings, ctx.flowBacked, createHomeyWebApiGet(),
    () => ctx.refreshTargetDevicesSnapshot({ fast: true, emitFlowBackedRefresh: false }),
  ).attach()
);
