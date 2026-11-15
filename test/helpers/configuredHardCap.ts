import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import type { HeldPowerLimitSettings } from '../../lib/power/heldCapacityLimit';

/**
 * A plan fixture's limits as live control holds them when the hard cap is the
 * configured one: what `resolveHeldPowerLimits` answers with the month-peak
 * switch off.
 */
export const configuredHardCap = (settings: PowerLimitSettings): HeldPowerLimitSettings => ({
  ...settings,
  hardCapSource: 'configured',
  configuredLimitKw: settings.limitKw,
});
