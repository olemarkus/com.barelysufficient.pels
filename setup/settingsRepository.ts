import type Homey from 'homey';
import type { FlowReportedCapabilitiesByDevice } from '../lib/device/transport/flowReportedCapabilities';
import { readFlowReportedCapabilitiesSetting } from '../lib/device/flowReportedCapabilitiesSetting';
import {
  classifyExpectedPowerOverridesSetting,
  type ExpectedPowerOverridesRead,
  type PersistedRecordReadEvidence,
} from '../lib/device/devicePowerPeak';
import type { MainMeterSelection } from '../packages/contracts/src/mainMeterSelection';
import type { DeviceExpectedPowerOverrides } from '../packages/contracts/src/types';
import { readMainMeterSelection } from './mainMeterSettings';
import {
  DEVICE_EXPECTED_POWER_OVERRIDES,
  FLOW_REPORTED_DEVICE_CAPABILITIES,
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

  loadFlowReportedCapabilities(): ReturnType<typeof readFlowReportedCapabilitiesSetting> {
    return readFlowReportedCapabilitiesSetting(this.homey.settings);
  }

  /**
   * Writes the flow-reported capabilities map back to settings. Two callers:
   * the boot-time filter's result, once entries for capabilities whose backing
   * flow cards aren't installed in this Homey have been stripped; and the live
   * map after a flow report changes a device's state.
   */
  saveFlowReportedCapabilities(state: FlowReportedCapabilitiesByDevice): void {
    this.homey.settings.set(FLOW_REPORTED_DEVICE_CAPABILITIES, state);
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
      return { raw, keyPresent: this.homey.settings.getKeys().includes(key) };
    } catch {
      return null;
    }
  }

  /**
   * The owner's manual expected-power figures, entry-validated and classified:
   * `resolved` with an empty record is a real answer, and `unavailable` means the
   * key could not be read, so the caller must neither adopt it nor write over it.
   * These are figures a person typed, so overwriting them from an unreadable boot
   * would lose something no observation can recover.
   */
  loadExpectedPowerOverrides(): ExpectedPowerOverridesRead {
    const evidence = this.readPersistedRecordEvidence(DEVICE_EXPECTED_POWER_OVERRIDES);
    return evidence ? classifyExpectedPowerOverridesSetting(evidence) : { state: 'unavailable' };
  }

  saveExpectedPowerOverrides(overrides: DeviceExpectedPowerOverrides): void {
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
