import type { DeviceExpectedPowerOverrides } from '../../packages/contracts/src/types';
import type {
  ExpectedPowerOverridesRead,
  LearnedPeaksByDeviceId,
  LearnedPeaksRead,
} from './devicePowerPeak';
import type { FlowReportedCapabilitiesByDevice } from './transport/flowReportedCapabilities';
import type { FlowReportedCapabilitiesRead } from './flowReportedCapabilitiesSetting';

/**
 * The persisted device state this layer owns, as the six calls that touch it.
 *
 * `SettingsRepository` (`setup/settingsRepository.ts`) implements this on top
 * of `homey.settings` and structurally satisfies it; the port is declared here
 * because the values are the device layer's, and because a domain module may
 * not name a type from `setup/` (`no-lib-to-setup`).
 *
 * Every read distinguishes resolved state, including genuinely empty records,
 * from unavailable settings. An unavailable read leaves accepted state intact.
 */
export type DevicePersistencePort = {
  loadFlowReportedCapabilities(): FlowReportedCapabilitiesRead;
  saveFlowReportedCapabilities(state: FlowReportedCapabilitiesByDevice): void;
  loadLearnedPeaks(): LearnedPeaksRead;
  saveLearnedPeaks(peaks: LearnedPeaksByDeviceId, nowMs: number): void;
  loadExpectedPowerOverrides(): ExpectedPowerOverridesRead;
  saveExpectedPowerOverrides(overrides: DeviceExpectedPowerOverrides): void;
};
