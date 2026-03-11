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
    buildOptimisticCapabilityUpdate,
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
    handlePowerUpdate as applyRealtimePowerUpdate,
    syncRealtimeCapabilityListeners,
    updateLastKnownPower,
} from './deviceManagerRuntime';
import {
    clearLocalCapabilityWrite,
    recordLocalCapabilityWrite,
    type RecentLocalCapabilityWrites,
} from './deviceManagerRealtimeSupport';
import { resolveHomeyInstance } from './deviceManagerHomeyApi';
import {
    handleRealtimeCapabilityUpdate,
    handleRealtimeDeviceUpdate,
} from './deviceManagerRealtimeHandlers';
import type { HomeyApiClient, HomeyApiConstructor } from './deviceManagerApiTypes';
import { shouldPromoteHomeyApiDebug } from './deviceManagerDebug';
const { HomeyAPI } = require('homey-api') as { HomeyAPI: HomeyApiConstructor };
const MIN_SIGNIFICANT_POWER_W = 5;
export const HOMEY_DEVICE_UPDATE_EVENT = 'device.update';
export const PLAN_RECONCILE_REALTIME_UPDATE_EVENT = 'plan_reconcile_realtime_update';

export class DeviceManager extends EventEmitter {
    private homeyApi?: HomeyApiClient;
    private logger: Logger;
    private homey: Homey.App;
    private latestSnapshot: TargetDeviceSnapshot[] = [];
    private powerState: Required<PowerEstimateState>;
    private capabilityInstances: Map<string, CapabilityInstance> = new Map();
    private hasRealtimeDeviceUpdateListener = false;
    private recentLocalCapabilityWrites: RecentLocalCapabilityWrites = new Map();
    private providers: {
        getPriority?: (deviceId: string) => number;
        getControllable?: (deviceId: string) => boolean;
        getManaged?: (deviceId: string) => boolean;
        getExperimentalEvSupportEnabled?: () => boolean;
    } = {};
    private readonly handleRealtimeDeviceUpdate = (device: HomeyDeviceLike): void => {
        handleRealtimeDeviceUpdate({
            device,
            latestSnapshot: this.latestSnapshot,
            shouldTrackRealtimeDevice: (deviceId) => this.shouldTrackRealtimeDevice(deviceId),
            parseDevice: (nextDevice, nowTs) => this.parseDevice(nextDevice, nowTs, {}),
            logDebug: (message) => this.logger.debug(message),
            emitPlanReconcile: (event) => this.emit(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, event),
        });
    };

    private readonly handleRealtimeCapabilityUpdate = (
        deviceId: string,
        label: string,
        capabilityId: string,
        value: unknown,
    ): void => {
        handleRealtimeCapabilityUpdate({
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
            logDebug: (message) => this.logger.debug(message),
            emitPlanReconcile: (event) => this.emit(PLAN_RECONCILE_REALTIME_UPDATE_EVENT, event),
        });
    };

    constructor(homey: Homey.App, logger: Logger, providers?: {
        getPriority?: (deviceId: string) => number;
        getControllable?: (deviceId: string) => boolean;
        getManaged?: (deviceId: string) => boolean;
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
            const list = await this.fetchDevices();
            const livePowerWByDeviceId = options.includeLivePower === false
                ? {}
                : await this.fetchLivePowerWattsByDeviceId();
            const snapshot = this.parseDeviceList(list, livePowerWByDeviceId);
            this.latestSnapshot = snapshot;
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
            throw error;
        }

        const optimisticUpdate = buildOptimisticCapabilityUpdate(capabilityId, value);
        if (optimisticUpdate) {
            this.updateLocalSnapshot(deviceId, optimisticUpdate);
        } else if (this.shouldPreserveLocalBinaryState(deviceId, capabilityId, value)) {
            this.updateLocalSnapshot(deviceId, { on: value });
        }

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
        if (capabilityId !== 'onoff' && capabilityId !== 'evcharger_charging') return false;
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
            return result.devices;
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
        this.removeAllListeners();
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
        const powerCapable = capsStatus.hasPower
            || typeof powerEstimate.loadKw === 'number'
            || typeof powerEstimate.measuredPowerKw === 'number'
            || hasPotentialHomeyEnergyEstimate(device)
            || powerEstimate.hasEnergyEstimate === true;

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
            capabilities,
            canSetControl,
            available,
        };
    }

    private getCapabilityObj(device: HomeyDeviceLike): DeviceCapabilityMap {
        if (device.capabilitiesObj && typeof device.capabilitiesObj === 'object') {
            return device.capabilitiesObj as DeviceCapabilityMap;
        }
        return {};
    }
}
