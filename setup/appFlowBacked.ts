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
} from '../lib/device/transport/stateOfCharge';
import { FLOW_REPORTED_DEVICE_CAPABILITIES } from '../lib/utils/settingsKeys';
import { normalizeError } from '../lib/utils/errorUtils';
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
const EXPECTED_OVERRIDE_EQUALS_EPSILON_KW = 0.000001;

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
  getExpectedPowerKwOverrides: () => Record<string, { kw: number; ts: number }>;
  syncHeadroomUsageObservation: (params: { deviceId: string; usageObservation: { kw: number } }) => void;
}

export class AppFlowBacked {
  private flowReportedCapabilitiesEmptyParseWarned = false;
  private flowBackedCardsAvailable?: boolean;
  private flowDeviceAutocompleteCache?: { devices: HomeyDeviceLike[]; fetchedAtMs: number };
  private flowDeviceAutocompleteRequest?: Promise<HomeyDeviceLike[]>;

  constructor(private readonly deps: AppFlowBackedDeps) {}

  setExpectedOverride(deviceId: string, kw: number): boolean {
    if (this.deps.getSteppedLoadProfile(deviceId)) {
      throw new Error(
        'Stepped load devices use configured planning power per step; '
        + 'expected power override is not supported.',
      );
    }
    const overrides = this.deps.getExpectedPowerKwOverrides();
    const existing = overrides[deviceId];
    if (typeof existing?.kw === 'number' && Math.abs(existing.kw - kw) <= EXPECTED_OVERRIDE_EQUALS_EPSILON_KW) {
      return false;
    }
    overrides[deviceId] = { kw, ts: Date.now() };
    this.deps.syncHeadroomUsageObservation({
      deviceId,
      usageObservation: { kw },
    });
    return true;
  }

  loadFlowReportedCapabilities(): void {
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
    const device = this.deps.getSnapshotDevice(deviceId);
    if (!this.deps.hasEnabledEvBoostForSnapshot(device)) return false;
    if (!device?.flowBackedCapabilityIds?.includes(EV_SOC_CAPABILITY_ID)) return false;
    if (update.valueChanged) return true;
    if (!update.freshnessAdvanced) return false;
    return this.canEvSocFreshnessBecomeFreshForBoost(device, update.entry.reportedAt);
  }

  private canEvSocFreshnessBecomeFreshForBoost(
    // Probe-widened: the snapshot physically carries the observed SoC bag the
    // base type omits; this app-layer seam mutates a copy's freshness in place.
    device: (TargetDeviceSnapshot & StateOfChargeObservedProbe) | undefined,
    reportedAt: number,
  ): boolean {
    const stateOfCharge = device?.stateOfCharge;
    if (!device || !stateOfCharge || stateOfCharge.status === 'fresh') return false;
    const nextDevice: TargetDeviceSnapshot & StateOfChargeObservedProbe = {
      ...device,
      targets: [...device.targets],
      stateOfCharge: { ...stateOfCharge },
    };
    updateStateOfChargeObservationFreshness({
      snapshot: nextDevice,
      reportedAt,
      nowMs: Date.now(),
    });
    return nextDevice.stateOfCharge?.status === 'fresh';
  }

  private syncFlowBackedObservationFreshness(params: {
    deviceId: string;
    capabilityId: FlowReportedCapabilityId;
    reportedAt: number;
  }): void {
    const snapshot = this.deps.getDeviceManager()?.getSnapshot();
    if (!snapshot) return;
    const device = snapshot.find((entry) => entry.id === params.deviceId);
    if (!device || device.flowBacked !== true) return;
    if (!isFlowReportedObservationCapabilityId(params.capabilityId)) {
      return;
    }
    if (params.capabilityId === EV_SOC_CAPABILITY_ID) {
      if (!device.flowBackedCapabilityIds?.includes(params.capabilityId)) return;
      updateStateOfChargeObservationFreshness({
        snapshot: device,
        reportedAt: params.reportedAt,
        nowMs: Date.now(),
      });
      // Deliberately NOT dispatched into the projection here: this branch only
      // advances `stateOfCharge` freshness (no `lastFreshDataMs` change), which
      // no projection reader consumes yet, and re-advertising the SoC capability
      // on this event would trip `shouldRebuildPlanForRealtimeEvSocObservation`
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
