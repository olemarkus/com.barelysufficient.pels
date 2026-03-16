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
    hasPotentialHomeyEnergyEstimate,
    resolvePreferredPowerRaw,
    type LiveDevicePowerWatts,
} from './deviceManagerEnergy';
import { fetchDevicesWithFallback, fetchLivePowerWattsByDeviceId } from './deviceManagerFetch';
import {
    applyMeasurementUpdates,
    type CapabilityInstance,
    detachRealtimeDeviceUpdateListener,
    hasRealtimeCapabilityListener,
    isRealtimeControlCapability,
    handlePowerUpdate as applyRealtimePowerUpdate,
    syncRealtimeCapabilityListeners,
    updateLastKnownPower,
} from './deviceManagerRuntime';
import {
    clearLocalCapabilityWrite,
    formatBinaryState,
    recordLocalCapabilityWrite,
    type RecentLocalCapabilityWrites,
} from './deviceManagerRealtimeSupport';
import { resolveHomeyInstance } from './deviceManagerHomeyApi';
import {
    type HandleRealtimeCapabilityUpdateResult,
    type HandleRealtimeDeviceUpdateResult,
    handleRealtimeCapabilityUpdate,
    handleRealtimeDeviceUpdate,
    type ObservedDeviceStateEvent,
} from './deviceManagerRealtimeHandlers';
import type { HomeyApiClient, HomeyApiConstructor } from './deviceManagerApiTypes';
import { shouldPromoteHomeyApiDebug } from './deviceManagerDebug';
import type { DeviceFetchSource } from './deviceManagerFetch';
const HomeyAPI = require('homey-api/lib/HomeyAPI/HomeyAPI') as HomeyApiConstructor;
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
    private homeyApi?: HomeyApiClient;
    private logger: Logger;
    private homey: Homey.App;
    private latestSnapshot: TargetDeviceSnapshot[] = [];
    private powerState: Required<PowerEstimateState>;
    private capabilityInstances: Map<string, CapabilityInstance> = new Map();
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

    private readonly handleRealtimeCapabilityUpdate = (
        deviceId: string,
        label: string,
        capabilityId: string,
        value: unknown,
    ): void => {
        const result = handleRealtimeCapabilityUpdate({
            deviceId,
            label,
            capabilityId,
            value,
            latestSnapshot: this.latestSnapshot,
            recentLocalCapabilityWrites: this.recentLocalCapabilityWrites,
            shouldTrackRealtimeDevice: (nextDeviceId) => this.shouldTrackRealtimeDevice(nextDeviceId),
            handlePowerUpdate: (nextDeviceId, nextLabel, nextValue) => (
                this.handlePowerUpdate(nextDeviceId, nextLabel, nextValue)
            ),
            notePendingBinarySettleObservation: (nextDeviceId, capabilityId, nextValue) => (
                this.notePendingBinarySettleObservation(nextDeviceId, capabilityId, nextValue)
            ),
            logDebug: (message) => this.logger.debug(message),
            emitPlanReconcile: (event) => this.emit(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, event),
            emitObservedState: (event: ObservedDeviceStateEvent) => this.emit(PLAN_LIVE_STATE_OBSERVED_EVENT, event),
        });
        if (result.hadChanges) {
            this.recordRealtimeCapabilityObservation(deviceId, capabilityId, value, result);
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
    getHomeyApi(): HomeyApiClient | undefined { return this.homeyApi; }
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
        if (this.homeyApi) return;

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
            this.logger.debug('Homey API token/local URL/identity unavailable, skipping HomeyAPI client init');
            return;
        }

        try {
            this.homeyApi = await HomeyAPI.createAppAPI({
                homey: homeyInstance,
                debug: (...args: unknown[]) => {
                    if (!shouldPromoteHomeyApiDebug(args)) return;
                    this.logger.error('HomeyAPI:', ...args);
                },
            });
            this.logger.log('HomeyAPI initialized successfully');
        } catch (error) {
            this.logger.error('Failed to initialize HomeyAPI:', error);
        }
    }

    async refreshSnapshot(options: { includeLivePower?: boolean } = {}): Promise<void> {
        const stopSpan = startRuntimeSpan('device_snapshot_refresh');
        const start = Date.now();
        try {
            const previousSnapshot = this.latestSnapshot;
            const { devices: list, fetchSource } = await this.fetchDevicesForSnapshot();
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

    async setCapability(deviceId: string, capabilityId: string, value: unknown): Promise<void> {
        const setCapabilityValue = this.homeyApi?.devices?.setCapabilityValue;
        if (!setCapabilityValue) throw new Error('HomeyAPI not ready');
        const snapshotBefore = this.latestSnapshot.find((device) => device.id === deviceId);
        logEvCapabilityRequest({
            logger: this.logger,
            snapshotBefore,
            deviceId,
            capabilityId,
            value,
        });

        incPerfCounter('device_action_total');
        incPerfCounter(`device_action.capability.${capabilityId}`);
        recordLocalCapabilityWrite({
            recentLocalCapabilityWrites: this.recentLocalCapabilityWrites,
            deviceId,
            capabilityId,
            value,
        });
        this.startPendingBinarySettleWindow(deviceId, capabilityId, value, snapshotBefore?.name);
        try {
            await setCapabilityValue({
                deviceId,
                capabilityId,
                value,
            });
        } catch (error) {
            clearLocalCapabilityWrite({
                recentLocalCapabilityWrites: this.recentLocalCapabilityWrites,
                deviceId,
                capabilityId,
            });
            this.clearPendingBinarySettleWindow(deviceId, capabilityId);
            throw error;
        }

        const preservedLocalState = this.shouldPreserveLocalBinaryState(deviceId, capabilityId, value);
        if (preservedLocalState) {
            this.updateLocalSnapshot(deviceId, { on: value });
        }
        this.recordLocalWriteObservation(deviceId, capabilityId, value, {
            preservedLocalState,
        });

        const snapshotAfter = this.latestSnapshot.find((device) => device.id === deviceId);
        logEvCapabilityAccepted({
            logger: this.logger,
            snapshotAfter,
            deviceId,
            capabilityId,
            value,
        });
    }

    private shouldPreserveLocalBinaryState(
        deviceId: string,
        capabilityId: string,
        value: unknown,
    ): value is boolean {
        if (typeof value !== 'boolean') return false;
        if (!isRealtimeControlCapability(capabilityId)) return false;
        return !hasRealtimeCapabilityListener({
            capabilityInstances: this.capabilityInstances,
            deviceId,
            capabilityId,
        });
    }

    async applyDeviceTargets(targets: Record<string, number>, contextInfo = ''): Promise<void> {
        if (!this.homeyApi || !this.homeyApi.devices) {
            this.logger.debug('HomeyAPI not available, cannot apply device targets');
            return;
        }

        for (const device of this.latestSnapshot) {
            const targetValue = targets[device.id];
            if (typeof targetValue !== 'number' || Number.isNaN(targetValue)) continue;

            const targetCap = device.targets?.[0]?.id;
            if (!targetCap) continue;

            try {
                await this.setCapability(device.id, targetCap, targetValue);
                this.logger.log(`Set ${targetCap} for ${device.name} to ${targetValue} (${contextInfo})`);
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

            this.logger.log(`Dry-run: would set ${targetCap} for ${device.name} to ${targetValue}°C (${contextInfo})`);
        }
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
            const result = await fetchDevicesWithFallback({
                devicesApi: this.homeyApi?.devices,
                homey: this.homey,
                logger: this.logger,
                hasRealtimeDeviceUpdateListener: this.hasRealtimeDeviceUpdateListener,
                shouldTrackRealtimeDevice: (deviceId) => this.shouldTrackRealtimeDevice(deviceId),
                realtimeDeviceUpdateListener: this.handleRealtimeDeviceUpdate,
                realtimeDeviceUpdateEventName: HOMEY_DEVICE_UPDATE_EVENT,
                initRealtimeListeners: (devices) => this.initRealtimeListeners(devices),
            });
            this.hasRealtimeDeviceUpdateListener = result.hasRealtimeDeviceUpdateListener;
            return {
                devices: result.devices,
                fetchSource: result.fetchSource,
            };
        } finally {
            addPerfDuration('device_fetch_ms', Date.now() - start);
        }
    }

    private async fetchLivePowerWattsByDeviceId(): Promise<LiveDevicePowerWatts> {
        return fetchLivePowerWattsByDeviceId({
            energyApi: this.homeyApi?.energy,
            logger: this.logger,
        });
    }

    private async initRealtimeListeners(
        devices: HomeyDeviceLike[],
    ): Promise<void> {
        await syncRealtimeCapabilityListeners({
            devices,
            shouldTrackRealtimeDevice: (deviceId) => this.shouldTrackRealtimeDevice(deviceId),
            capabilityInstances: this.capabilityInstances,
            onCapabilityValue: (deviceId, label, capabilityId, value) => {
                this.handleRealtimeCapabilityUpdate(deviceId, label, capabilityId, value);
            },
            logger: this.logger,
        });
    }

    private handlePowerUpdate(deviceId: string, label: string, value: number | null): void {
        applyRealtimePowerUpdate({
            state: this.powerState,
            logger: this.logger,
            latestSnapshot: this.latestSnapshot,
            deviceId,
            label,
            value,
        });
    }

    private shouldTrackRealtimeDevice(deviceId: string): boolean {
        return this.providers.getManaged ? this.providers.getManaged(deviceId) === true : true;
    }

    public destroy(): void {
        const devicesApi = this.homeyApi?.devices;
        this.hasRealtimeDeviceUpdateListener = detachRealtimeDeviceUpdateListener({
            devicesApi,
            attached: this.hasRealtimeDeviceUpdateListener,
            listener: this.handleRealtimeDeviceUpdate,
            eventName: HOMEY_DEVICE_UPDATE_EVENT,
            logger: this.logger,
        });
        for (const instance of this.capabilityInstances.values()) {
            try {
                if (typeof instance.destroy === 'function') instance.destroy();
            } catch (_) { /* ignore */ }
        }
        this.capabilityInstances.clear();
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
        if (!hasRealtimeCapabilityListener({
            capabilityInstances: this.capabilityInstances,
            deviceId,
            capabilityId,
        })) {
            return;
        }

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

    private recordRealtimeCapabilityObservation(
        deviceId: string,
        capabilityId: string,
        value: unknown,
        result: HandleRealtimeCapabilityUpdateResult,
    ): void {
        const sources = this.getOrCreateDebugObservedSources(deviceId);
        sources.realtimeCapabilities[capabilityId] = {
            observedAt: Date.now(),
            path: 'realtime_capability',
            snapshot: this.buildCurrentDebugSnapshot(deviceId),
            capabilityId,
            value,
            localEcho: result.isLocalEcho,
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
