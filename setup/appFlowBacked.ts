import type { ExpectedPowerOverridesByDeviceId, LearnedPeaksByDeviceId } from '../lib/device/devicePowerPeak';
import {
  createLearnedPowerPeakState,
  type LearnedPowerPeakState,
} from './appInit/learnedPowerPeakState';
import {
  applyExpectedPowerOverrides,
  EXPECTED_OVERRIDE_EQUALS_EPSILON_KW,
  type ExpectedOverrideAuthority,
} from './expectedPowerOverrideState';
import type Homey from 'homey';
import type { HomeyDeviceLike } from '../lib/utils/types';
import {
  getFlowRefreshRequestedDeviceIds,
  isFlowReportedObservationCapabilityId,
  upsertFlowReportedCapability,
  type FlowReportedCapabilityId,
  type FlowReportedCapabilitiesByDevice,
  type FlowReportedCapabilitiesForDevice,
} from '../lib/device/transport/flowReportedCapabilities';
import {
  EV_SOC_CAPABILITY_ID,
  updateStateOfChargeObservationFreshness,
  wouldReportRestoreStateOfChargeLevel,
} from '../lib/device/transport/stateOfCharge';
import { hasObservedStateOfCharge } from '../packages/shared-domain/src/stateOfChargeObservedState';
import { FLOW_REPORTED_DEVICE_CAPABILITIES } from '../lib/utils/settingsKeys';
import { normalizeError } from '../lib/utils/errorUtils';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import type { Logger as PinoLogger } from '../lib/logging/logger';
import type { DeviceTransport } from '../lib/device/deviceTransport';
import type { SettingsRepository } from './settingsRepository';
import type {
  DecoratedDeviceSnapshot,
  StateOfChargeObservedProbe,
  TargetDeviceSnapshot,
} from '../packages/contracts/src/types';
import type { FlowBackedCapabilityReportOutcome } from '../lib/app/appContext';

const FLOW_DEVICE_AUTOCOMPLETE_CACHE_MS = 15 * 1000;

function resolveFlowBackedCapabilityReportOutcome(update: {
  stateChanged: boolean;
  valueChanged: boolean;
  freshnessAdvanced: boolean;
  capabilityId: FlowReportedCapabilityId;
  evSocRebuildPlan?: boolean;
}): FlowBackedCapabilityReportOutcome {
  if (update.stateChanged) {
    return {
      kind: 'state_changed',
      valueChanged: update.valueChanged,
      freshnessAdvanced: update.freshnessAdvanced,
      refreshSnapshot: true,
      rebuildPlan: update.capabilityId === EV_SOC_CAPABILITY_ID
        ? update.evSocRebuildPlan === true
        : true,
    };
  }
  if (update.freshnessAdvanced) {
    return {
      kind: 'freshness_only',
      valueChanged: false,
      freshnessAdvanced: true,
      refreshSnapshot: false,
      rebuildPlan: update.capabilityId === EV_SOC_CAPABILITY_ID && update.evSocRebuildPlan === true,
    };
  }
  return {
    kind: 'noop',
    valueChanged: false,
    freshnessAdvanced: false,
    refreshSnapshot: false,
    rebuildPlan: false,
  };
}

/**
 * Dependencies for {@link AppFlowBacked}. Flow-reported capability state stays
 * on `PelsApp` (read by the snapshot/UI seams) and flows in via getter/setter;
 * `expectedPowerKwOverrides` is shared with `DeviceTransport`, so the helper
 * mutates the same object via the getter. Cross-layer reads (`getSnapshotDevice`,
 * `hasEnabledEvBoostForSnapshot`, `resolveManagedState`) are app callbacks.
 */
export type AppFlowBackedDeps = {
  homey: Homey.App['homey'];
  settingsRepository: SettingsRepository;
  getStructuredLogger: (component: string) => PinoLogger | undefined;
  getFlowReportedCapabilities: () => FlowReportedCapabilitiesByDevice;
  setFlowReportedCapabilities: (state: FlowReportedCapabilitiesByDevice) => void;
  getDeviceManager: () => DeviceTransport | undefined;
  getLatestTargetSnapshot: () => DecoratedDeviceSnapshot[];
  resolveManagedState: (deviceId: string) => boolean | undefined;
  getSnapshotDevice: (deviceId: string) => TargetDeviceSnapshot | undefined;
  hasEnabledEvBoostForSnapshot: (device: TargetDeviceSnapshot | undefined) => boolean;
  getSteppedLoadProfile: (deviceId: string) => unknown;
  getExpectedPowerKwOverrides: () => ExpectedPowerOverridesByDeviceId;
  getLearnedPowerPeaks: () => LearnedPeaksByDeviceId;
  /** Owns the learned-peak trailing flush registered by `learnedPowerPeakState`. */
  timers: TimerRegistry;
  syncHeadroomUsageObservation: (params: { deviceId: string; usageObservation: { kw: number } }) => void;
}

export class AppFlowBacked {
  private flowReportedCapabilitiesEmptyParseWarned = false;
  private flowBackedCardsAvailable?: boolean;
  private flowDeviceAutocompleteCache?: { devices: HomeyDeviceLike[]; fetchedAtMs: number };
  private flowDeviceAutocompleteRequest?: Promise<HomeyDeviceLike[]>;

  /** True until a settings read has told us which figures are already stored. */
  private expectedPowerOverridesUnread = true;

  /**
   * Devices whose in-memory figure has NOT reached settings. Held so a retry of
   * the same value is not mistaken for "nothing changed" — that equality return
   * is what turned one failed write into a permanently unpersisted override.
   */
  private readonly unpersistedExpectedOverrideDeviceIds = new Set<string>();

  private readonly learnedPowerPeakState: LearnedPowerPeakState;

  constructor(private readonly deps: AppFlowBackedDeps) {
    this.learnedPowerPeakState = createLearnedPowerPeakState({
      settingsRepository: deps.settingsRepository,
      getPeaks: () => deps.getLearnedPowerPeaks(),
      timers: deps.timers,
      getStructuredLogger: () => deps.getStructuredLogger('devices'),
    });
  }

  /** Rate-limited, change-gated write of the learned measured peaks. */
  persistLearnedPeaks(): void {
    this.learnedPowerPeakState.persist();
  }

  /** Shutdown flush for a learned peak the rate limit is still holding. */
  flushLearnedPeaks(): void {
    this.learnedPowerPeakState.flush();
  }

  setExpectedOverride(deviceId: string, kw: number): boolean {
    if (this.deps.getSteppedLoadProfile(deviceId)) {
      throw new Error(
        'Stepped load devices use configured planning power per step; '
        + 'expected power override is not supported.',
      );
    }
    const overrides = this.deps.getExpectedPowerKwOverrides();
    const existing = overrides[deviceId];
    if (
      !this.unpersistedExpectedOverrideDeviceIds.has(deviceId)
      && typeof existing?.kw === 'number'
      && Math.abs(existing.kw - kw) <= EXPECTED_OVERRIDE_EQUALS_EPSILON_KW
    ) {
      return false;
    }
    overrides[deviceId] = { kw, ts: Date.now() };
    // Persist immediately. This is the owner's own figure for a device, entered
    // deliberately; losing it to a restart is how it used to silently revert to
    // whatever PELS could infer.
    this.persistExpectedPowerOverrides(deviceId, overrides);
    this.deps.syncHeadroomUsageObservation({
      deviceId,
      usageObservation: { kw },
    });
    return true;
  }

  /**
   * Write the manual figures, keeping the in-memory record and settings honest
   * about each other.
   *
   * The in-memory mutation stands either way — the run must honour what the
   * owner typed — but a device whose write did not land stays marked, so the
   * equality short-circuit above lets the same value through again instead of
   * reporting "unchanged" for a figure that never reached settings.
   */
  private persistExpectedPowerOverrides(
    deviceId: string,
    overrides: ExpectedPowerOverridesByDeviceId,
  ): void {
    // Never write over a record nobody has read. The boot read classifies an
    // unreadable key as `unavailable`, and writing the map we happen to hold
    // would erase every figure the owner typed on an earlier run.
    if (this.expectedPowerOverridesUnread && !this.loadExpectedPowerOverrides({
      // The figure being persisted is already in the map and is the newest
      // instruction there is, so this late read may only fill in the devices it
      // does not carry. Nothing to notify: `setExpectedOverride` syncs the
      // headroom observation for the device it just changed.
      authority: 'held',
      onOverrideChanged: () => {},
    })) {
      this.unpersistedExpectedOverrideDeviceIds.add(deviceId);
      return;
    }
    try {
      this.deps.settingsRepository.saveExpectedPowerOverrides(overrides);
      this.unpersistedExpectedOverrideDeviceIds.delete(deviceId);
    } catch (error) {
      this.unpersistedExpectedOverrideDeviceIds.add(deviceId);
      this.deps.getStructuredLogger('devices')?.error({
        event: 'expected_power_override_write_failed',
        deviceId,
        err: normalizeError(error),
      });
    }
  }

  /**
   * Read the owner's manual expected-power figures out of settings and adopt
   * them into the live map, answering whether the read RESOLVED.
   *
   * `unavailable` is an unreadable key, not an empty record, so the in-memory
   * map is left alone and the write path stays fenced until a read succeeds
   * (`feedback_homey_sdk_unreliable`, `notes/persisted-settings-state.md`). A
   * resolved-empty record is a real answer and adopts normally.
   *
   * The caller states the authority because the readers genuinely disagree about
   * which side is newer — see {@link ExpectedOverrideAuthority}.
   */
  private loadExpectedPowerOverrides(params: {
    authority: ExpectedOverrideAuthority;
    onOverrideChanged: (deviceId: string, kw: number) => void;
  }): boolean {
    const resolved = applyExpectedPowerOverrides({
      read: this.deps.settingsRepository.loadExpectedPowerOverrides(),
      target: this.deps.getExpectedPowerKwOverrides(),
      authority: params.authority,
      onOverrideChanged: params.onOverrideChanged,
    });
    // Any read that resolved — a stored record or a confirmed-empty one — is
    // proof the key is legible, which is all the write fence was waiting for.
    if (resolved) this.expectedPowerOverridesUnread = false;
    return resolved;
  }

  /**
   * Adopt a persisted CHANGE to the manual figures into the running app — the
   * settings-UI write path, dispatched by the settings handler for
   * `DEVICE_EXPECTED_POWER_OVERRIDES`.
   *
   * The runtime resolves expected power from the in-memory map, not from the
   * settings key (which is otherwise read only at boot), so without this an
   * owner's new figure would sit in storage until the next restart. The record
   * has the authority here: it is what the owner just wrote, down to the device
   * they cleared out of it. The headroom sync is the same seam
   * `setExpectedOverride` uses, so the settings-UI writer and the Flow writer
   * leave the app in the same state.
   */
  reloadExpectedPowerOverrides(): void {
    void this.loadExpectedPowerOverrides({
      authority: 'persisted',
      onOverrideChanged: (deviceId, kw) => this.deps.syncHeadroomUsageObservation({
        deviceId,
        usageObservation: { kw },
      }),
    });
  }

  /**
   * Restore every persisted record this helper owns: flow-reported capabilities,
   * the owner's manual expected-power figures, and the peaks PELS observed for
   * itself. One entry point because they are all restored in the same startup
   * step, each keeping its own transient-miss rule.
   */
  loadPersistedState(): void {
    this.loadFlowReportedCapabilities();
    void this.loadExpectedPowerOverrides({
      authority: 'held',
      onOverrideChanged: () => {
        // Nothing to notify at boot: the plan engine does not exist yet, and the
        // first plan build reads the restored map anyway.
      },
    });
    this.learnedPowerPeakState.load();
  }

  private loadFlowReportedCapabilities(): void {
    const parsed = this.deps.settingsRepository.loadFlowReportedCapabilities();
    // Homey SDK reads can transiently return falsy/empty data even when the
    // underlying setting is intact (see `feedback_homey_sdk_unreliable`). If
    // the parse came back empty but we already hold non-empty in-memory state,
    // treat this as a transient miss and keep the existing map rather than
    // wiping it. The persisted setting is also left untouched, so the next
    // successful read will reconcile from disk.
    const existing = this.deps.getFlowReportedCapabilities();
    if (
      Object.keys(parsed).length === 0
      && Object.keys(existing).length > 0
    ) {
      if (!this.flowReportedCapabilitiesEmptyParseWarned) {
        this.flowReportedCapabilitiesEmptyParseWarned = true;
        this.deps.getStructuredLogger('devices')?.warn({
          event: 'flow_capabilities_load_empty_parse_keeping_existing',
          inMemoryDeviceCount: Object.keys(existing).length,
        });
      }
      return;
    }
    const filtered = this.filterAvailableFlowReportedCapabilities(parsed);
    this.deps.setFlowReportedCapabilities(filtered);
    if (JSON.stringify(parsed) === JSON.stringify(filtered)) {
      return;
    }
    this.deps.settingsRepository.saveFlowReportedCapabilities(filtered);
    this.deps.getStructuredLogger('devices')?.info({
      event: 'flow_backed_state_cleared',
      reasonCode: 'cards_unavailable',
      previousDeviceCount: Object.keys(parsed).length,
      remainingDeviceCount: Object.keys(filtered).length,
    });
  }

  reportFlowBackedCapability(params: {
    deviceId: string;
    capabilityId: FlowReportedCapabilityId;
    value: boolean | number | string;
    reportedAt?: number;
  }): FlowBackedCapabilityReportOutcome {
    if (!this.isFlowReportedCapabilityAvailable(params.capabilityId)) {
      return {
        kind: 'noop',
        valueChanged: false,
        freshnessAdvanced: false,
        refreshSnapshot: false,
        rebuildPlan: false,
      };
    }
    const update = upsertFlowReportedCapability({
      state: this.deps.getFlowReportedCapabilities(),
      deviceId: params.deviceId,
      capabilityId: params.capabilityId,
      value: params.value,
      reportedAt: params.reportedAt,
    });
    if (update.stateChanged || (params.capabilityId === EV_SOC_CAPABILITY_ID && update.freshnessAdvanced)) {
      this.deps.homey.settings.set(FLOW_REPORTED_DEVICE_CAPABILITIES, this.deps.getFlowReportedCapabilities());
    }
    const evSocRebuildPlan = this.shouldRebuildPlanForFlowEvSocReport({
      deviceId: params.deviceId,
      capabilityId: params.capabilityId,
      update,
    });
    if (!update.stateChanged && update.freshnessAdvanced) {
      this.syncFlowBackedObservationFreshness({
        deviceId: params.deviceId,
        capabilityId: params.capabilityId,
        reportedAt: update.entry.reportedAt,
      });
    }
    return resolveFlowBackedCapabilityReportOutcome({
      ...update,
      capabilityId: params.capabilityId,
      evSocRebuildPlan,
    });
  }

  private shouldRebuildPlanForFlowEvSocReport(params: {
    deviceId: string;
    capabilityId: FlowReportedCapabilityId;
    update: {
      valueChanged: boolean;
      freshnessAdvanced: boolean;
      entry: { reportedAt: number };
    };
  }): boolean {
    const { deviceId, capabilityId, update } = params;
    if (capabilityId !== EV_SOC_CAPABILITY_ID) return false;
    // Probe-widened for the same reason as `canEvSocFreshnessBecomeFreshForBoost`
    // below: the snapshot physically carries the observed SoC bag the base type
    // omits.
    const device: (TargetDeviceSnapshot & StateOfChargeObservedProbe) | undefined = this.deps
      .getSnapshotDevice(deviceId);
    // A charger reading its level off an associated car ignores this flow card
    // entirely, so letting the report wake the planner would replan for a value
    // nothing reads.
    if (device && hasObservedStateOfCharge(device) && device.stateOfCharge.source === 'car') return false;
    if (!this.deps.hasEnabledEvBoostForSnapshot(device)) return false;
    if (this.deps.getDeviceManager()?.isFlowBackedCapability?.(deviceId, EV_SOC_CAPABILITY_ID) !== true) return false;
    if (update.valueChanged) return true;
    if (!update.freshnessAdvanced) return false;
    return this.canEvSocFreshnessBecomeFreshForBoost(device, update.entry.reportedAt);
  }

  private canEvSocFreshnessBecomeFreshForBoost(
    // Probe-widened: the snapshot physically carries the observed SoC bag the
    // base type omits. The producer answers whether the report would give this
    // charger a level; this seam only asks.
    device: (TargetDeviceSnapshot & StateOfChargeObservedProbe) | undefined,
    reportedAt: number,
  ): boolean {
    return wouldReportRestoreStateOfChargeLevel(device?.stateOfCharge, reportedAt);
  }

  private syncFlowBackedObservationFreshness(params: {
    deviceId: string;
    capabilityId: FlowReportedCapabilityId;
    reportedAt: number;
  }): void {
    const snapshot = this.deps.getDeviceManager()?.getSnapshot();
    if (!snapshot) return;
    // Probe-widened: the stored snapshot physically carries the observed SoC bag
    // the base type omits, and this seam mutates its freshness in place.
    const device: (TargetDeviceSnapshot & StateOfChargeObservedProbe) | undefined = snapshot
      .find((entry) => entry.id === params.deviceId);
    if (!device || device.flowBacked !== true) return;
    if (!isFlowReportedObservationCapabilityId(params.capabilityId)) {
      return;
    }
    if (params.capabilityId === EV_SOC_CAPABILITY_ID) {
      if (this.deps.getDeviceManager()?.isFlowBackedCapability(params.deviceId, params.capabilityId) !== true) return;
      // A car-sourced level is NOT the flow card's to keep alive. This helper
      // spreads the previous reading forward, so without this guard a flow card
      // that keeps firing would re-stamp the CAR's percentage as this charger's
      // own observation — laundering one device's reading into another's, and
      // outliving the association that justified adopting it.
      if (hasObservedStateOfCharge(device) && device.stateOfCharge.source === 'car') return;
      updateStateOfChargeObservationFreshness({
        snapshot: device,
        reportedAt: params.reportedAt,
      });
      // Deliberately NOT dispatched into the projection here: this branch only
      // advances `stateOfCharge` freshness (no `lastFreshDataMs` change), which
      // no projection reader consumes yet, and re-advertising the SoC capability
      // on this event would trip `the realtime SoC dispatch`
      // into the very plan rebuild this freshness-only heartbeat is meant to
      // skip. A future SoC-freshness projection reader handles its own dispatch.
      return;
    }
    const nextFreshDataMs = Math.max(device.lastFreshDataMs ?? 0, params.reportedAt);
    if (nextFreshDataMs <= (device.lastFreshDataMs ?? 0)) return;
    device.lastFreshDataMs = nextFreshDataMs;
    device.lastUpdated = nextFreshDataMs;
    // Steady (no value change) flow-backed reports only advance freshness in
    // place; dispatch so the projection-fed freshness reader stays faithful
    // instead of marking the device stale until the next value change/refresh.
    // Non-SoC capability id, so it can't trip the realtime EV-SoC rebuild gate.
    this.deps.getDeviceManager()?.dispatchObservedStateForDevice(params.deviceId, params.capabilityId);
  }

  async getHomeyDevicesForFlow(): Promise<HomeyDeviceLike[]> {
    const nowMs = Date.now();
    const cached = this.flowDeviceAutocompleteCache;
    if (cached && nowMs - cached.fetchedAtMs < FLOW_DEVICE_AUTOCOMPLETE_CACHE_MS) {
      return cached.devices;
    }
    if (this.flowDeviceAutocompleteRequest) {
      return this.flowDeviceAutocompleteRequest;
    }
    this.flowDeviceAutocompleteRequest = (async () => {
      const devices = await (this.deps.getDeviceManager()?.getDevicesForDebug() ?? []);
      this.flowDeviceAutocompleteCache = {
        devices: [...devices],
        fetchedAtMs: Date.now(),
      };
      return this.flowDeviceAutocompleteCache.devices;
    })().finally(() => {
      this.flowDeviceAutocompleteRequest = undefined;
    });
    return this.flowDeviceAutocompleteRequest;
  }

  async emitFlowBackedRefreshRequests(deviceIds: string[]): Promise<void> {
    if (deviceIds.length === 0) return;
    if (!this.areFlowBackedCardsAvailable()) return;
    const card = this.deps.homey.flow?.getTriggerCard?.('flow_backed_device_refresh_requested');
    if (!card?.trigger) return;
    const devices = await this.getHomeyDevicesForFlow();
    const deviceById = new Map(devices.map((device) => [device.id, device]));
    const flowReportedCapabilities = this.deps.getFlowReportedCapabilities();
    const ignoredNativeEvFlowIds = new Set(
      this.deps.getLatestTargetSnapshot()
        .filter((device) => (
          device.controlAdapter?.kind === 'capability_adapter'
          && !flowReportedCapabilities[device.id]?.measure_battery
          && (
            device.controlAdapter.activationEnabled === true
            || (
            device.controlAdapter.activationRequired !== true
            || this.deps.resolveManagedState(device.id) !== true
            )
          )
        ))
        .map((device) => device.id),
    );
    const eligibleDeviceIds = getFlowRefreshRequestedDeviceIds({
      state: flowReportedCapabilities,
      devices,
      candidateDeviceIds: deviceIds,
    }).filter((deviceId) => !ignoredNativeEvFlowIds.has(deviceId));
    if (eligibleDeviceIds.length === 0) return;
    const seen = new Set<string>();
    const triggers: Array<{ deviceId: string; trigger: Promise<unknown> }> = [];
    for (const rawDeviceId of eligibleDeviceIds) {
      const deviceId = rawDeviceId.trim();
      if (!deviceId || seen.has(deviceId)) continue;
      seen.add(deviceId);
      const device = deviceById.get(deviceId);
      this.deps.getStructuredLogger('devices')?.info({
        event: 'flow_backed_refresh_requested',
        deviceId,
        deviceName: device?.name,
      });
      triggers.push({
        deviceId,
        trigger: card.trigger({}, { deviceId }),
      });
    }
    if (triggers.length > 0) {
      const results = await Promise.allSettled(triggers.map(({ trigger }) => trigger));
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') return;
        this.deps.getStructuredLogger('devices')?.warn({
          event: 'flow_backed_refresh_request_failed',
          deviceId: triggers[index]?.deviceId,
          err: normalizeError(result.reason),
        });
      });
    }
  }

  areFlowBackedCardsAvailable(): boolean {
    if (typeof this.flowBackedCardsAvailable === 'boolean') {
      return this.flowBackedCardsAvailable;
    }
    this.flowBackedCardsAvailable = this.canAccessFlowCard('action', 'report_flow_backed_device_onoff')
      && this.canAccessFlowCard('trigger', 'flow_backed_device_refresh_requested');
    return this.flowBackedCardsAvailable;
  }

  private canAccessFlowCard(kind: 'action' | 'trigger', cardId: string): boolean {
    try {
      if (kind === 'action') {
        return Boolean(this.deps.homey.flow?.getActionCard?.(cardId));
      }
      return Boolean(this.deps.homey.flow?.getTriggerCard?.(cardId));
    } catch {
      return false;
    }
  }

  private isFlowReportedCapabilityAvailable(capabilityId: FlowReportedCapabilityId): boolean {
    if (capabilityId === EV_SOC_CAPABILITY_ID) {
      return this.canAccessFlowCard('action', 'report_evcharger_battery_level');
    }
    return this.areFlowBackedCardsAvailable();
  }

  private filterAvailableFlowReportedCapabilities(
    state: FlowReportedCapabilitiesByDevice,
  ): FlowReportedCapabilitiesByDevice {
    const next: FlowReportedCapabilitiesByDevice = {};
    for (const [deviceId, entries] of Object.entries(state)) {
      const filteredEntries = Object.fromEntries(
        Object.entries(entries).filter(([capabilityId]) => (
          this.isFlowReportedCapabilityAvailable(capabilityId as FlowReportedCapabilityId)
        )),
      ) as FlowReportedCapabilitiesForDevice;
      if (Object.keys(filteredEntries).length > 0) {
        next[deviceId] = filteredEntries;
      }
    }
    return next;
  }
}
