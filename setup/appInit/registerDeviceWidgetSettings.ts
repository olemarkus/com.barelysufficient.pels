import type { PelsHost } from '../../lib/app/pelsHost';
import type { DashboardsPort } from '../../lib/ports/homeyRuntime';
import { buildDeviceWidgetChoices } from '../../widgets/device/src/deviceWidgetPayload';

/**
 * Connect the Device widget's "Device" setting to the devices in PELS's plan.
 * The listener answers from the plan snapshot already published for the UI.
 */
export function registerDeviceWidgetSettings(
  dashboards: DashboardsPort,
  host: Pick<PelsHost, 'getLatestPlanSnapshotForUi'>,
): void {
  dashboards.getWidget('device').registerSettingAutocompleteListener(
    'device',
    (query) => buildDeviceWidgetChoices(host, query),
  );
}
