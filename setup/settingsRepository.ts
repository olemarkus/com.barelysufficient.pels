import type Homey from 'homey';
import {
  PowerCalibrationStore,
  loadPowerCalibrationStore,
} from '../lib/device/devicePowerCalibrationStore';
import {
  parseFlowReportedCapabilities,
  type FlowReportedCapabilitiesByDevice,
} from '../lib/device/transport/flowReportedCapabilities';
import type { PowerTrackerState } from '../packages/contracts/src/powerTrackerTypes';
import { isPowerTrackerState } from '../lib/utils/appTypeGuards';
import { FLOW_REPORTED_DEVICE_CAPABILITIES } from '../lib/utils/settingsKeys';

/**
 * Typed settings reads + writes that touch persisted Homey state owned by
 * the PelsApp boot path. Wraps `homey.settings.get`/`set` so the app code
 * doesn't repeat the parse-and-narrow dance and so future settings keys
 * land in one obvious place.
 *
 * Owns reads only when the parse is non-trivial (validation, typed
 * narrowing, store materialisation). Keys with no parsing — e.g. simple
 * scalars consumed inline — don't need to route through here.
 */
export class SettingsRepository {
  constructor(private readonly homey: Homey.App['homey']) {}

  /**
   * Returns the persisted power-tracker snapshot if it parses, otherwise
   * `undefined`. Caller decides whether to keep the existing in-memory
   * state (`undefined` return) or adopt the parsed state.
   */
  loadPowerTrackerState(): PowerTrackerState | undefined {
    const stored = this.homey.settings.get('power_tracker_state') as unknown;
    return isPowerTrackerState(stored) ? stored : undefined;
  }

  /**
   * Materialises the per-device power calibration store from persisted
   * settings. Returns a fresh `PowerCalibrationStore` instance — caller
   * is responsible for replacing the in-memory store (the calibration
   * store carries dirty samples that haven't flushed yet, so this should
   * only be called at startup or when explicitly resetting calibration).
   */
  loadPowerCalibrationStore(): PowerCalibrationStore {
    return loadPowerCalibrationStore({ homey: this.homey });
  }

  /**
   * Parses the persisted `FLOW_REPORTED_DEVICE_CAPABILITIES` shape.
   * Returns an empty map when the setting is missing or malformed.
   */
  loadFlowReportedCapabilities(): FlowReportedCapabilitiesByDevice {
    return parseFlowReportedCapabilities(
      this.homey.settings.get(FLOW_REPORTED_DEVICE_CAPABILITIES) as unknown,
    );
  }

  /**
   * Writes the (filtered) flow-reported capabilities map back to settings.
   * Used after the boot-time filter strips entries for capabilities whose
   * backing flow cards aren't installed in the current Homey environment.
   */
  saveFlowReportedCapabilities(filtered: FlowReportedCapabilitiesByDevice): void {
    this.homey.settings.set(FLOW_REPORTED_DEVICE_CAPABILITIES, filtered);
  }
}
