import type { ContinuousBatteryPlanRead } from '../continuousBatteryPlan.js';
import type { DeviceOverviewStrings } from '../deviceOverview.js';
import type { SettingsUiHomeScope } from '../homeScopedRead.js';
import type { SchedulesResponse } from '../schedules.js';
import type {
  DecoratedDeviceSnapshot,
  HomeBatteryControlCapability,
  ObservedStateOfChargeProbe,
  TargetPowerSteppedLoadPreset,
} from '../types.js';

/**
 * A device as `/ui_devices` serves it: the decorated snapshot, with the state of
 * charge already resolved to the level.
 *
 * The decoration carrier alone would leave `stateOfCharge` un-narrowed and raw —
 * the settings UI physically received the transport's whole working bag, and its
 * own device type widened straight back to it. Naming the resolved carrier here
 * makes the payload's shape the contract rather than a convention.
 */
export type SettingsUiDeviceSnapshot = DecoratedDeviceSnapshot & ObservedStateOfChargeProbe & SettingsUiBatteryState;

/**
 * A listed device's home-battery facts, resolved from the battery control
 * owner (`readSettingsUiBatteryState`) for every device, so the UI
 * never guesses one.
 */
export type SettingsUiBatteryState = {
  /** Whether PELS can drive this home battery now; `not_battery` for every other device. */
  batteryControl: HomeBatteryControlCapability | 'not_battery';
  /**
   * PELS turned this home battery's Managed off this run because the owner
   * changed its mode in the battery's own app. False for every other device.
   */
  batteryTakenOver: boolean;
};

/**
 * The EV control mode each charger's own app implies from how the charger is
 * wired, keyed by device id. Only chargers that report a phase count have an
 * entry; every other device is simply not a key.
 *
 * A fact about the installation, not the car (a single-phase car draws one
 * phase from a three-phase charger), so the settings UI uses it only as the
 * starting control mode it saves when the owner turns Managed on for a charger
 * with no control mode yet. Nothing keeps it in sync afterwards.
 */
export type ChargerPhasePresets = Readonly<Record<string, TargetPowerSteppedLoadPreset>>;

export type ChargerPhasePresetsRead =
  | { state: 'resolved'; presets: ChargerPhasePresets }
  | { state: 'unavailable' };

export type SettingsUiDevicesPayload = {
  /** Owner-resolved schedules for Main; unavailable for a scoped read. */
  schedules: SchedulesResponse;
  // Served from the app-layer managed-device join of DeviceReads metadata,
  // Observer state, and stepped-load decoration,
  // so the payload carries the stepped-load step-command/planning decoration
  // the settings-UI reads (`selectedStepId` / `planningPowerKw` / ...). Typed
  // as the decoration carrier rather than the raw transport snapshot.
  // The served objects are the transport-owned snapshots, which physically
  // carry the observed EV plug-state the base type omits (`EvObservedFields`
  // slice). Deliberately NOT probe-widened for that: exposing `EvObservedProbe`
  // on the consumer contract would re-permit un-narrowed optional reads across
  // the settings-UI — consumers must narrow through `isEvObserved`. The physical
  // carriage is pinned by the ui_devices payload test instead
  // (`test/integration/settingsUiApi.test.ts`).
  //
  // State of charge is the exception, and it is declared rather than physical:
  // it is RESOLVED before it is served (`withResolvedStateOfCharge`), so what
  // crosses is the level and not the transport's working bag. Saying so in the
  // type is the point — while the payload merely carried the bag, the settings
  // UI's own device type widened straight back to it and read the raw report.
  devices: SettingsUiDeviceSnapshot[];
  /** Main-home native solar controls; solar telemetry stays outside `devices`. */
  inverterDevices: { id: string; name: string }[];
  /** Owner-resolved plans for visible Main-home batteries; empty for scoped/unavailable rosters. */
  continuousBatteryPlans: Record<string, ContinuousBatteryPlanRead>;
  // Read from the same device list `devices` comes from, unmanaged chargers
  // included (the opt-in it serves happens before a charger is managed). The
  // tagged read keeps an unavailable device snapshot distinct from a trusted
  // snapshot whose resolved preset map is genuinely empty.
  chargerPhasePresets: ChargerPhasePresetsRead;
  // True when the home has at least one auto-tracked solar/PV device (deviceClass
  // 'solarpanel'). The PV device itself is excluded from `devices` (observe-only), so
  // this home-level flag is the only signal the settings UI has that solar exists — it
  // gates the per-device "Use solar surplus" control, which is otherwise meaningless
  // (and misleading) in a home that does not export.
  // Optional (with hasExhibitedExport below) for one reason: an `unavailable`
  // scoped read OMITS both flags rather than fabricating `false` — absence, not
  // a measurement. Every whole-home and resolved scoped payload carries them.
  hasManagedSolarDevice?: boolean;
  // True when the home has exhibited material accumulated grid export (a stable
  // export-kWh signal), even without a role-detected solar device — the meter-only PV
  // case (string inverter, no Homey solarpanel device). Broadens the "Use solar surplus"
  // toggle gate so such homes, whose surplus-absorb engine already works off whole-home
  // net export, also get the control. Source-blind: both power sources report signed net,
  // so a flow home exhibits export on exactly the same evidence as a Homey Energy one.
  hasExhibitedExport?: boolean;
  // True when this home's solar-surplus pool can EVER be non-zero — it has
  // recorded ANY grid export, or its curtailment estimator can contribute
  // (`resolveSurplusPoolReachable`). Gates the per-device "Use solar surplus"
  // toggle, which is not merely inert without it: the runtime declines to stamp
  // the posture on an unreachable pool (else the standing hold keeps the device
  // OFF forever), so a toggle offered here would switch on and do nothing.
  //
  // Its export bar is strictly WEAKER than `hasExhibitedExport`'s 1 kWh
  // materiality floor, and deliberately so: the question is whether the feed can
  // express export at all, which one negative sample settles. Do not collapse
  // the two flags together — the floor would black this out for the first ~20
  // minutes of a home's first sunny afternoon.
  //
  // Distinct from the two flags above, and all three are needed. Solar presence
  // and export history unlock the export-PRICE section, which needs no pool at
  // all; only this one says the surplus ENGINE can act. A flow home whose Flow
  // predates signed watts has solar, no export, and no reachable pool.
  //
  // Optional for the same reason as its neighbours: an `unavailable` scoped read
  // omits it rather than fabricating `false`.
  surplusPoolReachable?: boolean;
  // Present only on a `?homeId=` read; absent keeps the whole-home payload
  // byte-identical. `unavailable` means the empty `devices: []` is the empty
  // shape, NOT "this home manages nothing" (the two solar flags are then
  // omitted for the same reason).
  homeScope?: SettingsUiHomeScope;
};

/**
 * The deliberately narrow result of an explicit Homey Flow conflict scan.
 * Everything else on `/ui_devices` remains owned by that read model; this
 * command reports the conflict and native-control facts it refreshed, keyed
 * by device id.
 */
export type SettingsUiFlowConflictRefreshDevice = Pick<
  SettingsUiDeviceSnapshot,
  'id' | 'flowConflict' | 'controlAdapter'
>;

export type SettingsUiEvSocFlowReporter = {
  chargerDeviceId: string;
  /** Present only when exactly one named enabled Flow reports for the charger. */
  flowName?: string;
};

export type SettingsUiFlowConflictRefreshPayload = {
  devices: SettingsUiFlowConflictRefreshDevice[];
  evSocReporters: SettingsUiEvSocFlowReporter[];
};

// One recorded device-overview transition. The message fields are built from
// the same backend-resolved `DeviceStatus` the cards render
// (`buildDeviceLogEntry`, `lib/plan/deviceOverviewLog.ts`), and the runtime
// `device_overview_changed` event carries the same strings, so the visible
// device-log wording matches the backend transition logs exactly. `stateTone`
// is the same tone token the live device cards use, so the log can colour the
// state line consistently without re-deriving it.
export type SettingsUiDeviceLogEntry = DeviceOverviewStrings & {
  atMs: number;
  stateKind: string;
  stateTone: string;
};

/** A historical observation, including the recording session it belongs to. */
export type SettingsUiDeviceActivityEntry = SettingsUiDeviceLogEntry & {
  id: string;
  deviceId: string;
  deviceName: string;
  recordingStartedAtMs: number;
};

export type SettingsUiDeviceLogPayload = {
  version: 2;
  // Newest first. Retention is bounded by age and count, never a complete audit trail.
  entries: SettingsUiDeviceActivityEntry[];
  retentionDays: number;
  maxEntriesPerDevice: number;
  maxEntries: number;
  persistence: 'stored' | 'pending';
};
