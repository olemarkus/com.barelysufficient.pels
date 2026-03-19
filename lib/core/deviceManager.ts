/* eslint-disable max-lines --
 * DeviceManager intentionally centralizes snapshot, realtime, and debug observation flows.
 */
import Homey from 'homey';
import { EventEmitter } from 'events';
import { HomeyDeviceLike, Logger, TargetDeviceSnapshot } from '../utils/types';
import {
    getCapabilities,
    getDeviceId,
    getIsAvailable,
    resolveDeviceClassKey,
    resolveDeviceLabel,
    resolveZoneLabel,
} from './deviceManagerHelpers';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { estimatePower, type PowerEstimateState } from './powerEstimate';
import { startRuntimeSpan } from '../utils/runtimeTrace';
import {
    getCanSetControl,
    getControlCapabilityId,
    getCurrentOn,
    getEvChargingState,
    logEvCapabilityAccepted,
    logEvCapabilityRequest,
    logEvSnapshotChanges,
    type DeviceCapabilityMap,
} from './deviceManagerControl';
import {
    buildTargets,
    getCapabilityValueByPrefix,
    getCurrentTemperature,
    resolveDeviceCapabilities,
} from './deviceManagerParse';
import {
    normalizeTargetCapabilityValue,
} from '../../packages/contracts/src/targetCapabilities';
import {
    hasPotentialHomeyEnergyEstimate,
    resolvePreferredPowerRaw,
    type LiveDevicePowerWatts,
} from './deviceManagerEnergy';
import { fetchDevicesByIds, fetchDevicesWithFallback, fetchLivePowerWattsByDeviceId } from './deviceManagerFetch';
import {
    applyMeasurementUpdates,
    isRealtimeControlCapability,
    updateLastKnownPower,
} from './deviceManagerRuntime';
import {
    clearLocalCapabilityWrite,
    formatBinaryState,
    recordLocalCapabilityWrite,
    type RecentLocalCapabilityWrites,
} from './deviceManagerRealtimeSupport';
import {
    getSdkDevicesApi,
    hasRestClient,
    initHomeyHttpClient,
    resolveHomeyInstance,
    setRawCapabilityValue,
} from './deviceManagerHomeyApi';
import {
    type HandleRealtimeDeviceUpdateResult,
    handleRealtimeDeviceUpdate,
    type ObservedDeviceStateEvent,
} from './deviceManagerRealtimeHandlers';
import { resolveHomeyEnergyApiFromSdk, type HomeyEnergyApi } from '../utils/homeyEnergy';
import type { DeviceFetchSource } from './deviceManagerFetch';

const MIN_SIGNIFICANT_POWER_W = 5;
const LOCAL_BINARY_SETTLE_WINDOW_MS = 5 * 1000;
export const HOMEY_DEVICE_UPDATE_EVENT = 'device.update';
export const PLAN_RECONCILE_REALTIME_UPDATE_EVENT = 'plan_reconcile_realtime_update';
export const PLAN_LIVE_STATE_OBSERVED_EVENT = 'plan_live_state_observed';

type PendingBinarySettleWindow = {
    deviceId: string;
    capabilityId: string;
    name: string;
    desired: boolean;
    latestObserved?: boolean;
    timer: ReturnType<typeof setTimeout>;
};

export type DeviceDebugObservedSource = {
    observedAt: number;
    path: 'snapshot_refresh' | 'device_update' | 'realtime_capability' | 'local_write';
    snapshot: TargetDeviceSnapshot | null;
    fetchSource?: DeviceFetchSource;
    capabilityId?: string;
    value?: unknown;
    localEcho?: boolean;
    shouldReconcilePlan?: boolean;
    preservedLocalState?: boolean;
    changes?: Array<{
        capabilityId: string;
        previousValue: string;
        nextValue: string;
    }>;
};

export type DeviceDebugObservedSources = {
    snapshotRefresh?: DeviceDebugObservedSource;
    deviceUpdate?: DeviceDebugObservedSource;
    realtimeCapabilities: Record<string, DeviceDebugObservedSource>;
    localWrites: Record<string, DeviceDebugObservedSource>;
};

function cloneTargetDeviceSnapshotForDebug(snapshot: TargetDeviceSnapshot | null): TargetDeviceSnapshot | null {
    if (!snapshot) return null;
    return {
        ...snapshot,
        targets: snapshot.targets.map((target) => ({ ...target })),
        capabilities: Array.isArray(snapshot.capabilities) ? [...snapshot.capabilities] : snapshot.capabilities,
    };
}

function cloneObservedSource(source: DeviceDebugObservedSource): DeviceDebugObservedSource {
    return {
        ...source,
        snapshot: cloneTargetDeviceSnapshotForDebug(source.snapshot),
        changes: source.changes?.map((change) => ({ ...change })),
    };
}

function createEmptyObservedSources(): DeviceDebugObservedSources {
    return {
        realtimeCapabilities: {},
        localWrites: {},
    };
}

export class DeviceManager extends EventEmitter {
    private sdkReady = false;
    private sdkDevicesApi: EventEmitter | null = null;
    private sdkEnergyApi: HomeyEnergyApi | null = null;
    private logger: Logger;
    private homey: Homey.App;
    private latestSnapshot: TargetDeviceSnapshot[] = [];
    private powerState: Required<PowerEstimateState>;
    private hasRealtimeDeviceUpdateListener = false;
    private recentLocalCapabilityWrites: RecentLocalCapabilityWrites = new Map();
    private pendingBinarySettleWindows: Map<string, PendingBinarySettleWindow> = new Map();
    private debugObservedSourcesByDeviceId: Map<string, DeviceDebugObservedSources> = new Map();
    private providers: {
        getPriority?: (deviceId: string) => number;
        getControllable?: (deviceId: string) => boolean;
        getManaged?: (deviceId: string) => boolean;
        getBudgetExempt?: (deviceId: string) => boolean;
        getExperimentalEvSupportEnabled?: () => boolean;
    } = {};
    private readonly handleRealtimeDeviceUpdate = (device: HomeyDeviceLike): void => {
        const deviceId = getDeviceId(device);
        const result = handleRealtimeDeviceUpdate({
            device,
            latestSnapshot: this.latestSnapshot,
            recentLocalCapabilityWrites: this.recentLocalCapabilityWrites,
            shouldTrackRealtimeDevice: (deviceId) => this.shouldTrackRealtimeDevice(deviceId),
            parseDevice: (nextDevice, nowTs) => this.parseDevice(nextDevice, nowTs, {}),
            notePendingBinarySettleObservation: (nextDeviceId, capabilityId, value) => (
                this.notePendingBinarySettleObservation(nextDeviceId, capabilityId, value)
            ),
            logDebug: (message) => this.logger.debug(message),
            emitPlanReconcile: (event) => this.emit(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, event),
            emitObservedState: (event: ObservedDeviceStateEvent) => this.emit(PLAN_LIVE_STATE_OBSERVED_EVENT, event),
        });
        if (deviceId && result.hadChanges) {
            this.recordDeviceUpdateObservation(deviceId, result);
        }
    };

    constructor(homey: Homey.App, logger: Logger, providers?: {
        getPriority?: (deviceId: string) => number;
        getControllable?: (deviceId: string) => boolean;
        getManaged?: (deviceId: string) => boolean;
        getBudgetExempt?: (deviceId: string) => boolean;
        getExperimentalEvSupportEnabled?: () => boolean;
    }, powerState?: PowerEstimateState) {
        super();
        this.homey = homey;
        this.logger = logger;
        if (providers) this.providers = providers;
        this.powerState = {
            expectedPowerKwOverrides: powerState?.expectedPowerKwOverrides ?? {},
            lastKnownPowerKw: powerState?.lastKnownPowerKw ?? {},
            lastMeasuredPowerKw: powerState?.lastMeasuredPowerKw ?? {},
            lastMeterEnergyKwh: powerState?.lastMeterEnergyKwh ?? {},
        };
    }

    getSnapshot(): TargetDeviceSnapshot[] { return this.latestSnapshot; }
    setSnapshotForTests(snapshot: TargetDeviceSnapshot[]): void { this.setSnapshot(snapshot); }
    setSnapshot(snapshot: TargetDeviceSnapshot[]): void { this.latestSnapshot = snapshot; }
    parseDeviceListForTests(list: HomeyDeviceLike[]): TargetDeviceSnapshot[] { return this.parseDeviceList(list); }
    async getDevicesForDebug(): Promise<HomeyDeviceLike[]> { return this.fetchDevices(); }
    getDebugObservedSources(deviceId: string): DeviceDebugObservedSources | null {
        const sources = this.debugObservedSourcesByDeviceId.get(deviceId);
        if (!sources) return null;
        return {
            ...(sources.snapshotRefresh ? { snapshotRefresh: cloneObservedSource(sources.snapshotRefresh) } : {}),
            ...(sources.deviceUpdate ? { deviceUpdate: cloneObservedSource(sources.deviceUpdate) } : {}),
            realtimeCapabilities: Object.fromEntries(
                Object.entries(sources.realtimeCapabilities).map(([capabilityId, source]) => [
                    capabilityId,
                    cloneObservedSource(source),
                ]),
            ),
            localWrites: Object.fromEntries(
                Object.entries(sources.localWrites).map(([capabilityId, source]) => [
                    capabilityId,
                    cloneObservedSource(source),
                ]),
            ),
        };
    }

    async init(): Promise<void> {
        if (this.sdkReady) return;

        const homeyInstance = resolveHomeyInstance(this.homey);

        if (
            !homeyInstance
            || !homeyInstance.api
            || typeof homeyInstance.api.getOwnerApiToken !== 'function'
            || typeof homeyInstance.api.getLocalUrl !== 'function'
            || !homeyInstance.cloud
            || typeof homeyInstance.cloud.getHomeyId !== 'function'
            || !homeyInstance.platform
            || !homeyInstance.platformVersion
        ) {
            this.logger.debug('Homey SDK API unavailable, skipping init');
            return;
        }

        try {
            await initHomeyHttpClient(this.homey);
        } catch (error) {
            this.logger.error('Failed to initialize HTTP client, continuing in degraded mode', error);
            return;
        }

        this.sdkEnergyApi = resolveHomeyEnergyApiFromSdk(homeyInstance);
        this.sdkReady = true;
        this.attachSdkRealtimeListener();
        this.logger.log('Device API initialized from SDK');
    }

    async refreshSnapshot(options: { includeLivePower?: boolean; targetedRefresh?: boolean } = {}): Promise<void> {
        const stopSpan = startRuntimeSpan('device_snapshot_refresh');
        const start = Date.now();
        try {
            const previousSnapshot = this.latestSnapshot;
            let fetchResult: Awaited<ReturnType<typeof fetchDevicesWithFallback>>;
            try {
                fetchResult = options.targetedRefresh && this.latestSnapshot.length > 0
                    ? await this.fetchDevicesByKnownIds()
                    : await this.fetchDevicesForSnapshot();
            } catch (error) {
                this.logger.error('Device snapshot refresh failed, keeping previous snapshot', error);
                return;
            }
            const { devices: list, fetchSource } = fetchResult;
            const livePowerWByDeviceId = options.includeLivePower === false
                ? {}
                : await this.fetchLivePowerWattsByDeviceId();
            const snapshot = this.parseDeviceList(list, livePowerWByDeviceId);
            this.preserveFresherRealtimeCapabilityObservations({
                previousSnapshot,
                nextSnapshot: snapshot,
                devices: list,
            });
            this.latestSnapshot = snapshot;
            this.recordSnapshotRefreshObservations(snapshot, fetchSource);
            this.logger.debug(`Device snapshot refreshed: ${snapshot.length} devices found`);
            logEvSnapshotChanges({
                logger: this.logger,
                previousSnapshot,
                nextSnapshot: snapshot,
            });
        } finally {
            stopSpan();
            addPerfDuration('device_refresh_ms', Date.now() - start);
        }
    }

    updateLocalSnapshot(deviceId: string, updates: { target?: number | null; on?: boolean }): void {
        const snap = this.latestSnapshot.find((d) => d.id === deviceId);
        if (!snap) return;

        if (typeof updates.target === 'number') {
            if (snap.targets && snap.targets[0]) {
                snap.targets[0].value = updates.target;
            }
        }
        if (typeof updates.on === 'boolean') {
            snap.currentOn = updates.on;
        }
    }

    async setCapability(deviceId: string, capabilityId: string, value: unknown): Promise<unknown> {
        if (!hasRestClient()) throw new Error('REST client not ready');
        const normalizedValue = this.normalizeCapabilityValue(deviceId, capabilityId, value);
        const snapshotBefore = this.latestSnapshot.find((device) => device.id === deviceId);
        logEvCapabilityRequest({
            logger: this.logger,
            snapshotBefore,
            deviceId,
            capabilityId,
            value: normalizedValue,
        });

        incPerfCounter('device_action_total');
        incPerfCounter(`device_action.capability.${capabilityId}`);
        recordLocalCapabilityWrite({
            recentLocalCapabilityWrites: this.recentLocalCapabilityWrites,
            deviceId,
            capabilityId,
            value: normalizedValue,
        });
        this.startPendingBinarySettleWindow(deviceId, capabilityId, normalizedValue, snapshotBefore?.name);
        try {
            await setRawCapabilityValue(deviceId, capabilityId, normalizedValue);
        } catch (error) {
            clearLocalCapabilityWrite({
                recentLocalCapabilityWrites: this.recentLocalCapabilityWrites,
                deviceId,
                capabilityId,
            });
            this.clearPendingBinarySettleWindow(deviceId, capabilityId);
            throw error;
        }

        // Without per-capability realtime listeners, always preserve local binary state
        const preservedLocalState = typeof normalizedValue === 'boolean'
            && isRealtimeControlCapability(capabilityId);
        if (preservedLocalState) {
            this.updateLocalSnapshot(deviceId, { on: normalizedValue });
        }
        this.recordLocalWriteObservation(deviceId, capabilityId, normalizedValue, {
            preservedLocalState,
        });

        const snapshotAfter = this.latestSnapshot.find((device) => device.id === deviceId);
        logEvCapabilityAccepted({
            logger: this.logger,
            snapshotAfter,
            deviceId,
            capabilityId,
            value: normalizedValue,
        });
        return normalizedValue;
    }

    async applyDeviceTargets(targets: Record<string, number>, contextInfo = ''): Promise<void> {
        if (!this.sdkReady) {
            this.logger.debug('SDK API not available, cannot apply device targets');
            return;
        }

        for (const device of this.latestSnapshot) {
            const targetValue = targets[device.id];
            if (typeof targetValue !== 'number' || Number.isNaN(targetValue)) continue;

            const targetCap = device.targets?.[0]?.id;
            if (!targetCap) continue;

            try {
                const appliedValue = await this.setCapability(device.id, targetCap, targetValue);
                this.logger.log(`Set ${targetCap} for ${device.name} to ${String(appliedValue)} (${contextInfo})`);
            } catch (error) {
                this.logger.error(`Failed to set ${targetCap} for ${device.name}`, error);
            }
        }

        await this.refreshSnapshot();
    }

    previewDeviceTargets(targets: Record<string, number>, contextInfo = ''): void {
        for (const device of this.latestSnapshot) {
            const targetValue = targets[device.id];
            if (typeof targetValue !== 'number' || Number.isNaN(targetValue)) continue;

            const targetCap = device.targets?.[0]?.id;
            if (!targetCap) continue;

            const target = device.targets.find((entry) => entry.id === targetCap);
            const normalizedValue = typeof targetValue === 'number'
                ? normalizeTargetCapabilityValue({ target, value: targetValue })
                : targetValue;
            this.logger.log(
                `Dry-run: would set ${targetCap} for ${device.name} `
                + `to ${normalizedValue}°C (${contextInfo})`,
            );
        }
    }

    private normalizeCapabilityValue(deviceId: string, capabilityId: string, value: unknown): unknown {
        if (typeof value !== 'number' || !Number.isFinite(value)) return value;
        const snapshot = this.latestSnapshot.find((device) => device.id === deviceId);
        const target = snapshot?.targets.find((entry) => entry.id === capabilityId);
        if (!target) return value;
        return normalizeTargetCapabilityValue({ target, value });
    }

    private async fetchDevices(): Promise<HomeyDeviceLike[]> {
        const result = await this.fetchDevicesForSnapshot();
        return result.devices;
    }

    private async fetchDevicesForSnapshot(): Promise<{
        devices: HomeyDeviceLike[];
        fetchSource: DeviceFetchSource;
    }> {
        const start = Date.now();
        try {
            return await fetchDevicesWithFallback({
                logger: this.logger,
            });
        } finally {
            addPerfDuration('device_fetch_ms', Date.now() - start);
        }
    }

    private async fetchDevicesByKnownIds(): Promise<{
        devices: HomeyDeviceLike[];
        fetchSource: DeviceFetchSource;
    }> {
        const start = Date.now();
        try {
            const deviceIds = this.latestSnapshot.map((d) => d.id);
            return await fetchDevicesByIds({
                deviceIds,
                logger: this.logger,
            });
        } finally {
            addPerfDuration('device_fetch_ms', Date.now() - start);
        }
    }

    private async fetchLivePowerWattsByDeviceId(): Promise<LiveDevicePowerWatts> {
        return fetchLivePowerWattsByDeviceId({
            energyApi: this.sdkEnergyApi ?? undefined,
            logger: this.logger,
        });
    }

    private attachSdkRealtimeListener(): void {
        const devicesApi = getSdkDevicesApi(this.homey);
        if (!devicesApi) {
            this.logger.debug('SDK devices API not available for realtime events');
            return;
        }
        this.sdkDevicesApi = devicesApi;
        devicesApi.on('realtime', this.handleSdkRealtimeEvent);
        this.hasRealtimeDeviceUpdateListener = true;
        this.logger.debug('SDK realtime device listener attached');
    }

    private detachSdkRealtimeListener(): void {
        if (!this.sdkDevicesApi) return;
        try {
            this.sdkDevicesApi.off('realtime', this.handleSdkRealtimeEvent);
        } catch (_) { /* ignore */ }
        this.sdkDevicesApi = null;
        this.hasRealtimeDeviceUpdateListener = false;
    }

    private readonly handleSdkRealtimeEvent = (event: string, data: unknown): void => {
        if (event === HOMEY_DEVICE_UPDATE_EVENT && data && typeof data === 'object') {
            this.handleRealtimeDeviceUpdate(data as HomeyDeviceLike);
            return;
        }
        // Future: handle other event types if needed
    };

    private shouldTrackRealtimeDevice(deviceId: string): boolean {
        return this.providers.getManaged ? this.providers.getManaged(deviceId) === true : true;
    }

    public destroy(): void {
        this.detachSdkRealtimeListener();
        for (const pending of this.pendingBinarySettleWindows.values()) {
            clearTimeout(pending.timer);
        }
        this.pendingBinarySettleWindows.clear();
        this.removeAllListeners();
    }

    private startPendingBinarySettleWindow(
        deviceId: string,
        capabilityId: string,
        value: unknown,
        deviceName?: string,
    ): void {
        if (typeof value !== 'boolean') return;
        if (!isRealtimeControlCapability(capabilityId)) return;
        if (!this.hasRealtimeDeviceUpdateListener) return;

        this.clearPendingBinarySettleWindow(deviceId, capabilityId);
        const key = this.buildPendingBinarySettleKey(deviceId, capabilityId);
        const timer = setTimeout(() => {
            this.finalizePendingBinarySettleWindow(key);
        }, LOCAL_BINARY_SETTLE_WINDOW_MS);
        this.pendingBinarySettleWindows.set(key, {
            deviceId,
            capabilityId,
            name: deviceName || deviceId,
            desired: value,
            timer,
        });
    }

    private clearPendingBinarySettleWindow(deviceId: string, capabilityId: string): void {
        const key = this.buildPendingBinarySettleKey(deviceId, capabilityId);
        const pending = this.pendingBinarySettleWindows.get(key);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingBinarySettleWindows.delete(key);
    }

    private notePendingBinarySettleObservation(
        deviceId: string,
        capabilityId: string,
        value: boolean,
    ): boolean {
        const key = this.buildPendingBinarySettleKey(deviceId, capabilityId);
        const pending = this.pendingBinarySettleWindows.get(key);
        if (!pending) return false;
        pending.latestObserved = value;
        return true;
    }

    private finalizePendingBinarySettleWindow(key: string): void {
        const pending = this.pendingBinarySettleWindows.get(key);
        if (!pending) return;
        this.pendingBinarySettleWindows.delete(key);
        if (!this.shouldTrackRealtimeDevice(pending.deviceId)) return;

        const snapshot = this.latestSnapshot.find((device) => device.id === pending.deviceId);
        if (!snapshot) return;
        const observed = typeof snapshot?.currentOn === 'boolean'
            ? snapshot.currentOn
            : pending.latestObserved;
        if (observed === pending.desired) {
            this.logger.debug(
                `Binary settle confirmed for ${pending.name} (${pending.deviceId}) via ${pending.capabilityId}: `
                + `${formatBinaryState(observed)}`,
            );
            return;
        }

        const changes = typeof observed === 'boolean'
            ? [{
                capabilityId: pending.capabilityId,
                previousValue: formatBinaryState(pending.desired),
                nextValue: formatBinaryState(observed),
            }]
            : undefined;
        this.logger.debug(
            `Binary settle expired for ${pending.name} (${pending.deviceId}) via ${pending.capabilityId}: `
            + `expected ${formatBinaryState(pending.desired)}, observed ${formatBinaryState(observed)}`,
        );
        this.emit(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, {
            deviceId: pending.deviceId,
            name: snapshot?.name || pending.name,
            capabilityId: pending.capabilityId,
            changes,
        });
    }

    private buildPendingBinarySettleKey(deviceId: string, capabilityId: string): string {
        return `${deviceId}:${capabilityId}`;
    }

    private parseDeviceList(
        list: HomeyDeviceLike[],
        livePowerWByDeviceId: LiveDevicePowerWatts = {},
    ): TargetDeviceSnapshot[] {
        const now = Date.now();
        return list
            .map((device) => this.parseDevice(device, now, livePowerWByDeviceId))
            .filter(Boolean) as TargetDeviceSnapshot[];
    }

    private parseDevice(
        device: HomeyDeviceLike,
        now: number,
        livePowerWByDeviceId: LiveDevicePowerWatts,
    ): TargetDeviceSnapshot | null {
        const deviceId = getDeviceId(device);
        if (!deviceId) {
            this.logger.error('Device missing ID, skipping:', device.name || 'unknown');
            return null;
        }
        const deviceClassKey = resolveDeviceClassKey({
            device,
            experimentalEvSupportEnabled: this.providers.getExperimentalEvSupportEnabled?.() === true,
        });
        if (!deviceClassKey) return null;
        const deviceLabel = resolveDeviceLabel(device, deviceId);
        const capabilities = getCapabilities(device);
        const capsStatus = resolveDeviceCapabilities({
            deviceClassKey,
            deviceId,
            deviceLabel,
            capabilities,
            logDebug: (...args: unknown[]) => this.logger.debug(...args),
        });
        if (!capsStatus) return null;
        const capabilityObj = this.getCapabilityObj(device);
        const currentTemperature = getCurrentTemperature(capabilityObj);
        const powerRaw = getCapabilityValueByPrefix(capabilities, capabilityObj, 'measure_power');
        const meterPowerRaw = getCapabilityValueByPrefix(capabilities, capabilityObj, 'meter_power');
        const livePowerRaw = livePowerWByDeviceId[deviceId];
        const preferredPowerRaw = resolvePreferredPowerRaw({ powerRaw, meterPowerRaw, livePowerRaw });
        const powerEstimate = estimatePower({
            device,
            deviceId,
            deviceLabel,
            powerRaw: preferredPowerRaw,
            meterPowerRaw,
            now,
            state: this.powerState,
            logger: this.logger,
            minSignificantPowerW: MIN_SIGNIFICANT_POWER_W,
            updateLastKnownPower: (id, kw, label) => updateLastKnownPower({
                state: this.powerState,
                logger: this.logger,
                deviceId: id,
                measuredKw: kw,
                deviceLabel: label,
            }),
            applyMeasurementUpdates: (id, updates, label) => applyMeasurementUpdates({
                state: this.powerState,
                logger: this.logger,
                deviceId: id,
                updates,
                deviceLabel: label,
            }),
        });
        const { targetCaps } = capsStatus;
        const targets = buildTargets(targetCaps, capabilityObj);
        const controlCapabilityId = getControlCapabilityId({ deviceClassKey, capabilities });
        const currentOn = getCurrentOn({ deviceClassKey, capabilityObj, controlCapabilityId });
        const canSetControl = getCanSetControl(controlCapabilityId, capabilityObj);
        const evChargingState = getEvChargingState(capabilityObj);
        const available = getIsAvailable(device);
        const zone = resolveZoneLabel(device);
        const deviceType: TargetDeviceSnapshot['deviceType'] = targetCaps.length > 0 ? 'temperature' : 'onoff';
        const powerCapable = this.isPowerCapable(device, capsStatus, powerEstimate);

        return {
            id: deviceId,
            name: device.name ?? deviceId,
            targets,
            deviceClass: deviceClassKey,
            deviceType,
            controlCapabilityId,
            powerKw: powerEstimate.powerKw,
            expectedPowerKw: powerEstimate.expectedPowerKw,
            expectedPowerSource: powerEstimate.expectedPowerSource,
            loadKw: powerEstimate.loadKw,
            powerCapable,
            priority: this.providers.getPriority ? this.providers.getPriority(deviceId) : undefined,
            currentOn,
            evChargingState,
            currentTemperature,
            measuredPowerKw: powerEstimate.measuredPowerKw,
            zone,
            controllable: this.providers.getControllable ? this.providers.getControllable(deviceId) : undefined,
            managed: this.providers.getManaged ? this.providers.getManaged(deviceId) : undefined,
            budgetExempt: this.providers.getBudgetExempt ? this.providers.getBudgetExempt(deviceId) : undefined,
            capabilities,
            canSetControl,
            available,
        };
    }

    private getOrCreateDebugObservedSources(deviceId: string): DeviceDebugObservedSources {
        let sources = this.debugObservedSourcesByDeviceId.get(deviceId);
        if (!sources) {
            sources = createEmptyObservedSources();
            this.debugObservedSourcesByDeviceId.set(deviceId, sources);
        }
        return sources;
    }

    private buildCurrentDebugSnapshot(deviceId: string): TargetDeviceSnapshot | null {
        const snapshot = this.latestSnapshot.find((entry) => entry.id === deviceId) ?? null;
        return cloneTargetDeviceSnapshotForDebug(snapshot);
    }

    private recordSnapshotRefreshObservations(
        snapshot: TargetDeviceSnapshot[],
        fetchSource: DeviceFetchSource,
    ): void {
        const observedAt = Date.now();
        const activeDeviceIds = new Set(snapshot.map((device) => device.id));
        for (const deviceId of this.debugObservedSourcesByDeviceId.keys()) {
            if (!activeDeviceIds.has(deviceId)) {
                this.debugObservedSourcesByDeviceId.delete(deviceId);
            }
        }
        for (const device of snapshot) {
            const sources = this.getOrCreateDebugObservedSources(device.id);
            sources.snapshotRefresh = {
                observedAt,
                path: 'snapshot_refresh',
                snapshot: cloneTargetDeviceSnapshotForDebug(device),
                fetchSource,
            };
        }
    }

    private recordDeviceUpdateObservation(
        deviceId: string,
        result: HandleRealtimeDeviceUpdateResult,
    ): void {
        const sources = this.getOrCreateDebugObservedSources(deviceId);
        sources.deviceUpdate = {
            observedAt: Date.now(),
            path: 'device_update',
            snapshot: this.buildCurrentDebugSnapshot(deviceId),
            shouldReconcilePlan: result.shouldReconcilePlan,
            ...(result.changes.length > 0 ? { changes: result.changes.map((change) => ({ ...change })) } : {}),
        };
    }

    private recordLocalWriteObservation(
        deviceId: string,
        capabilityId: string,
        value: unknown,
        options: { preservedLocalState: boolean },
    ): void {
        const sources = this.getOrCreateDebugObservedSources(deviceId);
        sources.localWrites[capabilityId] = {
            observedAt: Date.now(),
            path: 'local_write',
            snapshot: this.buildCurrentDebugSnapshot(deviceId),
            capabilityId,
            value,
            preservedLocalState: options.preservedLocalState,
        };
    }

    private preserveFresherRealtimeCapabilityObservations(params: {
        previousSnapshot: TargetDeviceSnapshot[];
        nextSnapshot: TargetDeviceSnapshot[];
        devices: HomeyDeviceLike[];
    }): void {
        const { previousSnapshot, nextSnapshot, devices } = params;
        const previousById = new Map(previousSnapshot.map((device) => [device.id, device]));
        const devicesById = new Map<string, HomeyDeviceLike>();
        for (const device of devices) {
            const deviceId = getDeviceId(device);
            if (!deviceId) continue;
            devicesById.set(deviceId, device);
        }

        for (const device of nextSnapshot) {
            const previous = previousById.get(device.id);
            const sourceDevice = devicesById.get(device.id);
            if (!previous || !sourceDevice) continue;

            if (device.controlCapabilityId) {
                this.preserveFresherRealtimeCapabilityObservation({
                    deviceId: device.id,
                    deviceName: device.name,
                    capabilityId: device.controlCapabilityId,
                    previousSnapshot: previous,
                    nextSnapshot: device,
                    sourceDevice,
                });
            }

            for (const target of device.targets) {
                this.preserveFresherRealtimeCapabilityObservation({
                    deviceId: device.id,
                    deviceName: device.name,
                    capabilityId: target.id,
                    previousSnapshot: previous,
                    nextSnapshot: device,
                    sourceDevice,
                });
            }
        }
    }

    private preserveFresherRealtimeCapabilityObservation(params: {
        deviceId: string;
        deviceName: string;
        capabilityId: string;
        previousSnapshot: TargetDeviceSnapshot;
        nextSnapshot: TargetDeviceSnapshot;
        sourceDevice: HomeyDeviceLike;
    }): void {
        const {
            deviceId,
            deviceName,
            capabilityId,
            previousSnapshot,
            nextSnapshot,
            sourceDevice,
        } = params;
        const sources = this.debugObservedSourcesByDeviceId.get(deviceId);
        const realtimeSource = sources?.realtimeCapabilities[capabilityId];
        if (!realtimeSource?.snapshot) return;

        const fetchedLastUpdatedMs = this.getCapabilityLastUpdatedMs(sourceDevice, capabilityId);
        if (typeof fetchedLastUpdatedMs !== 'number' || !Number.isFinite(fetchedLastUpdatedMs)) return;
        if (fetchedLastUpdatedMs >= realtimeSource.observedAt) return;

        if (capabilityId === nextSnapshot.controlCapabilityId) {
            if (typeof realtimeSource.snapshot.currentOn !== 'boolean') return;
            if (nextSnapshot.currentOn === realtimeSource.snapshot.currentOn) return;
            nextSnapshot.currentOn = realtimeSource.snapshot.currentOn;
            this.logger.debug(
                `Device snapshot refresh preserved newer realtime ${capabilityId} for ${deviceName} (${deviceId}); `
                + `fetched lastUpdated=${new Date(fetchedLastUpdatedMs).toISOString()}, `
                + `realtime observedAt=${new Date(realtimeSource.observedAt).toISOString()}`,
            );
            return;
        }

        const nextTarget = nextSnapshot.targets.find((target) => target.id === capabilityId);
        const previousTarget = previousSnapshot.targets.find((target) => target.id === capabilityId);
        const realtimeTarget = realtimeSource.snapshot.targets.find((target) => target.id === capabilityId);
        if (!nextTarget || !previousTarget || !realtimeTarget) return;
        if (!Object.is(previousTarget.value, realtimeTarget.value)) return;
        if (Object.is(nextTarget.value, realtimeTarget.value)) return;
        nextTarget.value = realtimeTarget.value;
        this.logger.debug(
            `Device snapshot refresh preserved newer realtime ${capabilityId} for ${deviceName} (${deviceId}); `
            + `fetched lastUpdated=${new Date(fetchedLastUpdatedMs).toISOString()}, `
            + `realtime observedAt=${new Date(realtimeSource.observedAt).toISOString()}`,
        );
    }

    private getCapabilityLastUpdatedMs(device: HomeyDeviceLike, capabilityId: string): number | undefined {
        const capabilityObj = this.getCapabilityObj(device);
        const rawValue = capabilityObj[capabilityId]?.lastUpdated;
        if (rawValue instanceof Date) return rawValue.getTime();
        if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue;
        if (typeof rawValue === 'string') {
            const parsed = Date.parse(rawValue);
            if (Number.isFinite(parsed)) return parsed;
        }
        return undefined;
    }

    private getCapabilityObj(device: HomeyDeviceLike): DeviceCapabilityMap {
        if (device.capabilitiesObj && typeof device.capabilitiesObj === 'object') {
            return device.capabilitiesObj as DeviceCapabilityMap;
        }
        return {};
    }

    private isPowerCapable(
        device: HomeyDeviceLike,
        capsStatus: NonNullable<ReturnType<typeof resolveDeviceCapabilities>>,
        powerEstimate: ReturnType<typeof estimatePower>,
    ): boolean {
        return capsStatus.hasPower
            || typeof powerEstimate.loadKw === 'number'
            || typeof powerEstimate.measuredPowerKw === 'number'
            || hasPotentialHomeyEnergyEstimate(device)
            || powerEstimate.hasEnergyEstimate === true;
    }
}
