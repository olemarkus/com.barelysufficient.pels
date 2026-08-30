import type Homey from 'homey';
import {
  PowerCalibrationStore,
  loadPowerCalibrationStore,
} from '../lib/device/devicePowerCalibrationStore';
import {
  parseFlowReportedCapabilities,
  type FlowReportedCapabilitiesByDevice,
} from '../lib/device/transport/flowReportedCapabilities';
import {
  classifyExpectedPowerOverridesSetting,
  classifyLearnedPeaksSetting,
  pruneExpiredLearnedPeaks,
  type ExpectedPowerOverridesByDeviceId,
  type ExpectedPowerOverridesRead,
  type LearnedPeaksByDeviceId,
  type LearnedPeaksRead,
  type PersistedRecordReadEvidence,
} from '../lib/device/devicePowerPeak';
import type { PowerTrackerState } from '../packages/contracts/src/powerTrackerTypes';
import type { MainMeterSelection } from '../packages/contracts/src/mainMeterSelection';
import { isPowerTrackerState, sanitizePowerTrackerSolarFields } from '../lib/utils/appTypeGuards';
import { readMainMeterSelection } from './mainMeterSettings';
import {
  DEVICE_EXPECTED_POWER_OVERRIDES,
  DEVICE_POWER_PEAKS,
  FLOW_REPORTED_DEVICE_CAPABILITIES,
  POWER_TRACKER_STATE,
} from '../lib/utils/settingsKeys';

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
   *
   * The optional solar families are field-level sanitized FIRST: a junk value
   * in one of them drops that field only, so corrupt solar data can never
   * fail the whole guard and cost the billed import history on the next
   * persist.
   */
  loadPowerTrackerState(): PowerTrackerState | undefined {
    const stored = sanitizePowerTrackerSolarFields(
      this.homey.settings.get(POWER_TRACKER_STATE) as unknown,
    );
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

  /**
   * Collect what one settings read saw, absorbing every SDK provenance here: a
   * thrown `get` or `getKeys` yields `null`, which the callers below turn into
   * `unavailable`. No caller ever sees an exception, an `undefined`, or an
   * SDK-shaped absence — only a classified result.
   */
  private readPersistedRecordEvidence(key: string): PersistedRecordReadEvidence | null {
    try {
      const raw = this.homey.settings.get(key) as unknown;
      const keys = this.homey.settings.getKeys();
      return { raw, keyPresent: keys.includes(key), keyListEmpty: keys.length === 0 };
    } catch {
      return null;
    }
  }

  /**
   * The learned measured peaks, entry-validated and classified.
   *
   * `resolved` with an empty record is a real answer (nothing learned yet, or
   * everything aged out); `unavailable` means the key could not be read, and the
   * caller must neither adopt it nor write over it. These used to be the same
   * `{}`, which on a cold boot let the first write replace weeks of learning
   * with nothing.
   */
  loadLearnedPeaks(): LearnedPeaksRead {
    const evidence = this.readPersistedRecordEvidence(DEVICE_POWER_PEAKS);
    return evidence ? classifyLearnedPeaksSetting(evidence) : { state: 'unavailable' };
  }

  /**
   * Persist the learned peaks, pruning entries whose window has closed so the
   * record does not accumulate devices that left the home years ago. Pruning on
   * WRITE and not on read keeps the read path free of mutation.
   */
  saveLearnedPeaks(peaks: LearnedPeaksByDeviceId, nowMs: number): void {
    this.homey.settings.set(DEVICE_POWER_PEAKS, pruneExpiredLearnedPeaks(peaks, nowMs));
  }

  /**
   * The owner's manual expected-power figures, entry-validated and classified on
   * the same resolved/unavailable contract as {@link loadLearnedPeaks} — and for
   * a sharper reason: these are figures a person typed, so overwriting them from
   * an unreadable boot would lose something no observation can recover.
   */
  loadExpectedPowerOverrides(): ExpectedPowerOverridesRead {
    const evidence = this.readPersistedRecordEvidence(DEVICE_EXPECTED_POWER_OVERRIDES);
    return evidence ? classifyExpectedPowerOverridesSetting(evidence) : { state: 'unavailable' };
  }

  saveExpectedPowerOverrides(overrides: ExpectedPowerOverridesByDeviceId): void {
    this.homey.settings.set(DEVICE_EXPECTED_POWER_OVERRIDES, overrides);
  }

  /**
   * Main's optional explicit whole-home meter, read fresh per call so a
   * changed selection takes effect without a restart. `resolved/null` is
   * Automatic; `unavailable` is a settings read that cannot say which meter
   * is authoritative, and the adapter consumes all SDK provenance to keep the
   * two apart — an unread selection must never arrive as Automatic.
   */
  loadMainMeterSelection(): MainMeterSelection {
    return readMainMeterSelection(this.homey.settings);
  }
}
