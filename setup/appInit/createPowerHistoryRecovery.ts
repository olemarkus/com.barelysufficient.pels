import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import type { HomeTrackerPersistence } from '../../lib/power/homeTrackerPersistence';
import type { PowerHistoryRecoveryPorts } from '../../lib/power/powerHistoryRecoveryOwner';
import { POWER_HISTORY_RECOVERY_REQUEST } from '../../packages/shared-domain/src/settings/powerHistoryRecovery';
import { readConfiguredPowerSource } from '../powerSourceSettings';
import { readMainMeterSelection } from '../mainMeterSettings';
import { createHomeyWebApiGet } from '../homeyWebApi';

/** Connect Main's explicit recovery to the selected meter and history owner. */
export const bindPowerHistoryRecoveryPorts = (
  settings: SettingsPort,
  getTracker: () => HomeTrackerPersistence,
  readTimeZone: () => string,
  isTornDown: () => boolean,
  onUpdated: () => void,
): PowerHistoryRecoveryPorts => ({
  readRequest: () => settings.get(POWER_HISTORY_RECOVERY_REQUEST),
  clearRequest: () => settings.unset(POWER_HISTORY_RECOVERY_REQUEST),
  readPowerSource: () => readConfiguredPowerSource(settings),
  readMainMeterSelection: () => readMainMeterSelection(settings),
  fetchInsights: createHomeyWebApiGet(),
  getTracker,
  nowMs: () => Date.now(),
  readTimeZone,
  isTornDown,
  onUpdated,
});
