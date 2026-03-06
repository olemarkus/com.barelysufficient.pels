import Homey from 'homey';
import { EventEmitter } from 'events';
import { HomeyDeviceLike, Logger, TargetDeviceSnapshot } from '../utils/types';
import type { HomeyEnergyApi } from '../utils/homeyEnergy';
import { resolveDeviceLabel, resolveZoneLabel } from './deviceManagerHelpers';
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
    extractLivePowerWattsByDeviceId,
    hasPotentialHomeyEnergyEstimate,
    resolvePreferredPowerRaw,
    type LiveDevicePowerWatts,
} from './deviceManagerEnergy';
import {
    applyMeasurementUpdates,
    getRawDevices,
    handlePowerUpdate,
    resolveHomeyInstance,
    updateLastKnownPower,
    writeErrorToStderr,
} from './deviceManagerRuntime';

type HomeyApiConstructor = {
    createAppAPI: (opts: {
        homey: Homey.App['homey'];
        debug?: ((...args: unknown[]) => void) | null;
    }) => Promise<HomeyApiClient>;
};
const { HomeyAPI } = require('homey-api') as { HomeyAPI: HomeyApiConstructor };

const SUPPORTED_DEVICE_CLASSES = new Set([
    'thermostat',
    'heater',
    'socket',
    'heatpump',
    'airconditioning',
    'airtreatment',
    'evcharger',
]);
const MIN_SIGNIFICANT_POWER_W = 5;

type HomeyApiDevicesClient = {
    getDevices?: () => Promise<Record<string, HomeyDeviceLike> | HomeyDeviceLike[]>;
    setCapabilityValue?: (args: { deviceId: string; capabilityId: string; value: unknown }) => Promise<void>;
    getDevice?: (args: { id: string }) => Promise<unknown>;
    getDeviceSettingsObj?: (args: { id: string }) => Promise<unknown>;
};

type HomeyApiClient = {
    devices?: HomeyApiDevicesClient;
    energy?: HomeyEnergyApi;
};

type CapabilityInstance = { destroy?: () => void };
type MakeCapabilityInstance = (
    capabilityId: string,
    listener: (value: number | null) => void,
) => CapabilityInstance | Promise<CapabilityInstance>;

export class DeviceManager extends EventEmitter {
    private homeyApi?: HomeyApiClient;
    private logger: Logger;
    private homey: Homey.App;
    private latestSnapshot: TargetDeviceSnapshot[] = [];
    private powerState: Required<PowerEstimateState>;
    private capabilityInstances: Map<string, CapabilityInstance> = new Map();

    private providers: {
        getPriority?: (deviceId: string) => number;
        getControllable?: (deviceId: string) => boolean;
        getManaged?: (deviceId: string) => boolean;
        getExperimentalEvSupportEnabled?: () => boolean;
    } = {};

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

    getSnapshot(): TargetDeviceSnapshot[] {
        return this.latestSnapshot;
    }

    // Test helper: allow direct snapshot injection
    setSnapshotForTests(snapshot: TargetDeviceSnapshot[]): void {
        this.setSnapshot(snapshot);
    }

    setSnapshot(snapshot: TargetDeviceSnapshot[]): void {
        this.latestSnapshot = snapshot;
    }

    // Test helper: reuse parsing logic
    parseDeviceListForTests(list: HomeyDeviceLike[]): TargetDeviceSnapshot[] {
        return this.parseDeviceList(list);
    }

    // Expose HomeyAPI instance for consumers that need direct access (e.g., app load lookups)
    getHomeyApi(): HomeyApiClient | undefined {
        return this.homeyApi;
    }

    // Debug helper: fetch full device list without mutating snapshots
    async getDevicesForDebug(): Promise<HomeyDeviceLike[]> {
        return this.fetchDevices();
    }

    async init(): Promise<void> {
        if (this.homeyApi) return;

        // Access the underlying Homey instance from the App instance
        // In real app and MockApp, this is this.homey.homey
        // In unit tests with POJO mock, this.homey IS the Homey instance mock
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
            this.homeyApi = await HomeyAPI.createAppAPI({ homey: homeyInstance });
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
        await setCapabilityValue({
            deviceId,
            capabilityId,
            value,
        });

        const optimisticUpdate = buildOptimisticCapabilityUpdate(capabilityId, value);
        if (optimisticUpdate) this.updateLocalSnapshot(deviceId, optimisticUpdate);

        const snapshotAfter = this.latestSnapshot.find((device) => device.id === deviceId);
        logEvCapabilityAccepted({
            logger: this.logger,
            snapshotAfter,
            deviceId,
            capabilityId,
            value,
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
            const devicesApi = this.homeyApi?.devices;
            if (devicesApi?.getDevices) {
                try {
                    const devicesObj = await devicesApi.getDevices();
                    const list = Array.isArray(devicesObj) ? devicesObj : Object.values(devicesObj || {});
                    this.logger.debug(`HomeyAPI returned ${list.length} devices`);
                    await this.initRealtimeListeners(devicesObj);
                    return list;
                } catch (error) {
                    this.logger.debug('HomeyAPI.getDevices failed, falling back to raw API', error as Error);
                }
            }

            // Fallback to manager/devices then /devices
            try {
                const devices = await getRawDevices(this.homey, 'manager/devices');
                const list = Array.isArray(devices) ? devices : Object.values(devices || {});
                this.logger.debug(`Manager API returned ${list.length} devices`);
                return list;
            } catch (err) {
                this.logger.debug('Manager API manager/devices failed, retrying devices', err as Error);
                try {
                    const devices = await getRawDevices(this.homey, 'devices');
                    const list = Array.isArray(devices) ? devices : Object.values(devices || {});
                    this.logger.debug(`Manager API devices returned ${list.length} devices`);
                    return list;
                } catch (error) {
                    this.logger.debug('Manager API devices failed as well', error as Error);
                    return [];
                }
            }
        } finally {
            addPerfDuration('device_fetch_ms', Date.now() - start);
        }
    }

    private async fetchLivePowerWattsByDeviceId(): Promise<LiveDevicePowerWatts> {
        const getLiveReport = this.homeyApi?.energy?.getLiveReport;
        if (typeof getLiveReport !== 'function') return {};
        try {
            const liveReport = await getLiveReport({});
            return extractLivePowerWattsByDeviceId(liveReport);
        } catch (error) {
            this.logger.debug('Homey energy live report unavailable for device snapshot', error as Error);
            return {};
        }
    }

    private async initRealtimeListeners(
        devicesObj: Record<string, HomeyDeviceLike> | HomeyDeviceLike[],
    ): Promise<void> {
        const devices = Array.isArray(devicesObj) ? devicesObj : Object.values(devicesObj);
        for (const device of devices) {
            const deviceId = this.getDeviceId(device);
            if (!deviceId || !device.capabilities?.includes('measure_power')) continue;

            // Check if listener already exists
            if (this.capabilityInstances.has(deviceId)) continue;

            try {
                const makeCapabilityInstance = (
                    device as { makeCapabilityInstance?: MakeCapabilityInstance }
                ).makeCapabilityInstance;
                if (typeof makeCapabilityInstance === 'function') {
                    const instance = await makeCapabilityInstance.call(
                        device,
                        'measure_power',
                        (value: number | null) => {
                            this.handlePowerUpdate(deviceId, device.name || deviceId, value);
                        },
                    );
                    this.capabilityInstances.set(deviceId, instance);
                    this.logger.debug(`Real-time power listener attached for ${device.name || deviceId}`);
                }
            } catch (error) {
                const label = device.name || deviceId || 'unknown';
                const message = `Failed to attach capability listener for ${label}`;
                this.logger.error(message, error);
                writeErrorToStderr(message, error);
            }
        }
    }

    private handlePowerUpdate(deviceId: string, label: string, value: number | null): void {
        handlePowerUpdate({
            state: this.powerState,
            logger: this.logger,
            latestSnapshot: this.latestSnapshot,
            deviceId,
            label,
            value,
        });
    }

    public destroy(): void {
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
        const deviceId = this.getDeviceId(device);
        if (!deviceId) {
            this.logger.error('Device missing ID, skipping:', device.name || 'unknown');
            return null;
        }
        const deviceClassKey = this.resolveDeviceClassKey(device);
        if (!deviceClassKey) return null;
        const deviceLabel = resolveDeviceLabel(device, deviceId);
        const capabilities = this.getCapabilities(device);
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
        const currentOn = this.getCurrentOn({ deviceClassKey, capabilityObj, controlCapabilityId });
        const canSetControl = getCanSetControl(controlCapabilityId, capabilityObj);
        const evChargingState = getEvChargingState(capabilityObj);
        const available = this.getIsAvailable(device);
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

    private getDeviceId(device: HomeyDeviceLike): string | null {
        return device.id || device.data?.id || null;
    }
    private getDeviceClass(device: HomeyDeviceLike): string | null {
        if (typeof device.class === 'string' && device.class.trim()) {
            return device.class.trim();
        }
        return null;
    }
    private resolveDeviceClassKey(device: HomeyDeviceLike): string | null {
        const deviceClass = this.getDeviceClass(device);
        if (!deviceClass) return null;
        const deviceClassKey = deviceClass.toLowerCase();
        if (!SUPPORTED_DEVICE_CLASSES.has(deviceClassKey)) {
            return null;
        }
        if (deviceClassKey === 'evcharger' && this.providers.getExperimentalEvSupportEnabled?.() !== true) {
            return null;
        }
        return deviceClassKey;
    }
    private getCapabilities(device: HomeyDeviceLike): string[] {
        return Array.isArray(device.capabilities) ? device.capabilities : [];
    }
    private getCapabilityObj(device: HomeyDeviceLike): DeviceCapabilityMap {
        if (device.capabilitiesObj && typeof device.capabilitiesObj === 'object') {
            return device.capabilitiesObj as DeviceCapabilityMap;
        }
        return {};
    }
    private getCurrentOn(params: {
        deviceClassKey: string;
        capabilityObj: DeviceCapabilityMap;
        controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
    }): boolean | undefined {
        return getCurrentOn(params);
    }
    private getIsAvailable(device: HomeyDeviceLike): boolean {
        if (typeof device.available === 'boolean') return device.available;
        return true;
    }
}
