import type {
  ExpectedPowerOverridesByDeviceId,
  ExpectedPowerOverridesRead,
  LearnedPeaksByDeviceId,
  LearnedPeaksRead,
} from './devicePowerPeak';
import type { FlowReportedCapabilitiesByDevice } from './transport/flowReportedCapabilities';

/**
 * The persisted device state this layer owns, as the six calls that touch it.
 *
 * `SettingsRepository` (`setup/settingsRepository.ts`) implements this on top
 * of `homey.settings` and structurally satisfies it; the port is declared here
 * because the values are the device layer's, and because a domain module may
 * not name a type from `setup/` (`no-lib-to-setup`).
 *
 * Two of the three reads are clean: `loadLearnedPeaks` and
 * `loadExpectedPowerOverrides` answer `resolved | unavailable`, so a consumer
 * never sees an SDK absence shape. **`loadFlowReportedCapabilities` is not** —
 * it returns a plain map and collapses "never written", "malformed" and
 * "genuinely empty" into the same empty record, and unlike the other two it
 * does not contain a throwing read. That is why its caller
 * (`FlowBackedDeviceState.loadFlowReportedCapabilities`) carries a
 * keep-what-we-hold heuristic for an empty parse: the hedge is load-bearing
 * until this read is promoted to the same discriminated shape, and deleting it
 * as a redundant defence restores a wipe-on-transient-miss bug. See TODO.md.
 */
export type DevicePersistencePort = {
  loadFlowReportedCapabilities(): FlowReportedCapabilitiesByDevice;
  saveFlowReportedCapabilities(state: FlowReportedCapabilitiesByDevice): void;
  loadLearnedPeaks(): LearnedPeaksRead;
  saveLearnedPeaks(peaks: LearnedPeaksByDeviceId, nowMs: number): void;
  loadExpectedPowerOverrides(): ExpectedPowerOverridesRead;
  saveExpectedPowerOverrides(overrides: ExpectedPowerOverridesByDeviceId): void;
};
