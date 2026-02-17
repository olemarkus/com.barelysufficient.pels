import Homey from 'homey';
import { EventEmitter } from 'events';
import { HomeyDeviceLike, Logger, TargetDeviceSnapshot } from '../utils/types';
import type { HomeyEnergyApi } from '../utils/homeyEnergy';
import { resolveDeviceLabel, resolveZoneLabel } from './deviceManagerHelpers';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { estimatePower, type PowerEstimateState } from './powerEstimate';
import type { PowerMeasurementUpdates } from './powerMeasurement';
import {
    extractLivePowerWattsByDeviceId,
    hasPotentialHomeyEnergyEstimate,
    resolvePreferredPowerRaw,
    type LiveDevicePowerWatts,
} from './deviceManagerEnergy';

type HomeyApiConstructor = {
    createAppAPI: (opts: { homey: Homey.App['homey']; debug?: ((...args: unknown[]) => void) | null }) => Promise<HomeyApiClient>;
};
const { HomeyAPI } = require('homey-api') as { HomeyAPI: HomeyApiConstructor };

const TARGET_CAPABILITY_PREFIXES = ['target_temperature'];
const SUPPORTED_DEVICE_CLASSES = new Set(['thermostat', 'heater', 'socket', 'heatpump', 'airconditioning', 'airtreatment']);
const POWER_CAPABILITY_PREFIXES = ['measure_power', 'meter_power'] as const;
const POWER_CAPABILITY_SET = new Set(POWER_CAPABILITY_PREFIXES);
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

type CapabilityValue = { value?: unknown; units?: string; setable?: boolean };
type CapabilityInstance = { destroy?: () => void };
type MakeCapabilityInstance = (capabilityId: string, listener: (value: number | null) => void) => CapabilityInstance | Promise<CapabilityInstance>;

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
    } = {};

    constructor(homey: Homey.App, logger: Logger, providers?: {
        getPriority?: (deviceId: string) => number;
        getControllable?: (deviceId: string) => boolean;
        getManaged?: (deviceId: string) => boolean;
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
        const homeyInstance = this.resolveHomeyInstance(this.homey);

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

    async refreshSnapshot(): Promise<void> {
        const start = Date.now();
        try {
            const list = await this.fetchDevices();
            const livePowerWByDeviceId = await this.fetchLivePowerWattsByDeviceId();
            const snapshot = this.parseDeviceList(list, livePowerWByDeviceId);
            this.latestSnapshot = snapshot;
            this.logger.debug(`Device snapshot refreshed: ${snapshot.length} devices found`);
        } finally {
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

        incPerfCounter('device_action_total');
        incPerfCounter(`device_action.capability.${capabilityId}`);
        await setCapabilityValue({
            deviceId,
            capabilityId,
            value,
        });

        // Update local snapshot optimistically
        if (capabilityId === 'onoff' && typeof value === 'boolean') {
            this.updateLocalSnapshot(deviceId, { on: value });
        } else if (TARGET_CAPABILITY_PREFIXES.some(prefix => capabilityId.startsWith(prefix)) && typeof value === 'number') {
            this.updateLocalSnapshot(deviceId, { target: value });
        }
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
                const devices = await this.getRawDevices('manager/devices');
                const list = Array.isArray(devices) ? devices : Object.values(devices || {});
                this.logger.debug(`Manager API returned ${list.length} devices`);
                return list;
            } catch (err) {
                this.logger.debug('Manager API manager/devices failed, retrying devices', err as Error);
                try {
                    const devices = await this.getRawDevices('devices');
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

    private async initRealtimeListeners(devicesObj: Record<string, HomeyDeviceLike> | HomeyDeviceLike[]): Promise<void> {
        const devices = Array.isArray(devicesObj) ? devicesObj : Object.values(devicesObj);
        for (const device of devices) {
            const deviceId = this.getDeviceId(device);
            if (!deviceId || !device.capabilities?.includes('measure_power')) continue;

            // Check if listener already exists
            if (this.capabilityInstances.has(deviceId)) continue;

            try {
                const makeCapabilityInstance = (device as { makeCapabilityInstance?: MakeCapabilityInstance }).makeCapabilityInstance;
                if (typeof makeCapabilityInstance === 'function') {
                    const instance = await makeCapabilityInstance.call(device, 'measure_power', (value: number | null) => {
                        this.handlePowerUpdate(deviceId, device.name || deviceId, value);
                    });
                    this.capabilityInstances.set(deviceId, instance);
                    this.logger.debug(`Real-time power listener attached for ${device.name || deviceId}`);
                }
            } catch (error) {
                const label = device.name || deviceId || 'unknown';
                const message = `Failed to attach capability listener for ${label}`;
                this.logger.error(message, error);
                this.writeErrorToStderr(message, error);
            }
        }
    }

    private handlePowerUpdate(deviceId: string, label: string, value: number | null): void {
        if (typeof value !== 'number' || !Number.isFinite(value)) return;

        const measuredKw = value / 1000;
        // Always update internal state
        this.powerState.lastMeasuredPowerKw[deviceId] = { kw: measuredKw, ts: Date.now() };
        this.updateLastKnownPower(deviceId, measuredKw, label);

        // Update snapshot cache if exists
        const snap = this.latestSnapshot.find(d => d.id === deviceId);
        if (snap) {
            snap.measuredPowerKw = measuredKw;
            snap.powerKw = measuredKw; // simplistic update, proper calculation is in refresh
        }

        // No realtime rebuild hook here; rebuilds are driven by power samples.
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
        const capsStatus = this.resolveDeviceCapabilities(capabilities);
        if (!capsStatus) return null;
        const capabilityObj = this.getCapabilityObj(device);
        const currentTemperature = this.getCurrentTemperature(capabilityObj);
        const powerRaw = this.getCapabilityValueByPrefix(capabilities, capabilityObj, 'measure_power');
        const meterPowerRaw = this.getCapabilityValueByPrefix(capabilities, capabilityObj, 'meter_power');
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
            updateLastKnownPower: (id, kw, label) => this.updateLastKnownPower(id, kw, label),
            applyMeasurementUpdates: (id, updates, label) => this.applyMeasurementUpdates(id, updates, label),
        });
        const { targetCaps } = capsStatus;
        const targets = this.buildTargets(targetCaps, capabilityObj);
        const currentOn = this.getCurrentOn(capabilityObj);
        const canSetOnOff = this.getCanSetOnOff(capabilityObj);
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
            powerKw: powerEstimate.powerKw,
            expectedPowerKw: powerEstimate.expectedPowerKw,
            expectedPowerSource: powerEstimate.expectedPowerSource,
            loadKw: powerEstimate.loadKw,
            powerCapable,
            priority: this.providers.getPriority ? this.providers.getPriority(deviceId) : undefined,
            currentOn,
            currentTemperature,
            measuredPowerKw: powerEstimate.measuredPowerKw,
            zone,
            controllable: this.providers.getControllable ? this.providers.getControllable(deviceId) : undefined,
            managed: this.providers.getManaged ? this.providers.getManaged(deviceId) : undefined,
            capabilities,
            canSetOnOff,
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
        return deviceClassKey;
    }
    private getCapabilities(device: HomeyDeviceLike): string[] {
        return Array.isArray(device.capabilities) ? device.capabilities : [];
    }
    private resolveDeviceCapabilities(capabilities: string[]): { targetCaps: string[]; hasPower: boolean } | null {
        const hasPower = this.hasPowerCapability(capabilities);
        const targetCaps = this.getTargetCaps(capabilities);
        const hasOnOff = capabilities.includes('onoff');
        if (targetCaps.length > 0 && !capabilities.includes('measure_temperature')) {
            return null;
        }
        if (targetCaps.length === 0 && !hasOnOff) {
            return null;
        }
        return { targetCaps, hasPower };
    }
    private getCapabilityObj(device: HomeyDeviceLike): Record<string, CapabilityValue> {
        if (device.capabilitiesObj && typeof device.capabilitiesObj === 'object') {
            return device.capabilitiesObj as Record<string, CapabilityValue>;
        }
        return {};
    }
    private hasPowerCapability(capabilities: string[]): boolean {
        return capabilities.some((cap) => (
            POWER_CAPABILITY_SET.has(cap as (typeof POWER_CAPABILITY_PREFIXES)[number])
            || POWER_CAPABILITY_PREFIXES.some((prefix) => cap.startsWith(`${prefix}.`))
        ));
    }
    private getCapabilityValueByPrefix(
        capabilities: string[],
        capabilityObj: Record<string, CapabilityValue>,
        prefix: (typeof POWER_CAPABILITY_PREFIXES)[number],
    ): unknown {
        if (capabilities.includes(prefix)) {
            const direct = capabilityObj[prefix]?.value;
            if (direct !== undefined) return direct;
        }
        const capId = capabilities.find((cap) => cap === prefix || cap.startsWith(`${prefix}.`));
        return capId ? capabilityObj[capId]?.value : undefined;
    }

    private getCurrentTemperature(capabilityObj: Record<string, CapabilityValue>): number | undefined {
        const temp = capabilityObj.measure_temperature?.value;
        return typeof temp === 'number' ? temp : undefined;
    }
    private getTargetCaps(capabilities: string[]): string[] {
        return capabilities.filter((cap) => TARGET_CAPABILITY_PREFIXES.some((prefix) => cap.startsWith(prefix)));
    }
    private buildTargets(targetCaps: string[], capabilityObj: Record<string, CapabilityValue>): TargetDeviceSnapshot['targets'] {
        return targetCaps.map((capId) => ({
            id: capId,
            value: capabilityObj[capId]?.value ?? null,
            unit: capabilityObj[capId]?.units || '°C',
        }));
    }
    private getCurrentOn(
        capabilityObj: Record<string, CapabilityValue>,
    ): boolean | undefined {
        if (typeof capabilityObj.onoff?.value === 'boolean') {
            return capabilityObj.onoff.value;
        }
        return undefined;
    }
    private getCanSetOnOff(capabilityObj: Record<string, CapabilityValue>): boolean | undefined {
        if (!capabilityObj.onoff) return undefined;
        if (typeof capabilityObj.onoff.setable === 'boolean') {
            return capabilityObj.onoff.setable;
        }
        return true;
    }
    private updateLastKnownPower(deviceId: string, measuredKw: number, deviceLabel: string): void {
        const previousPeak = this.powerState.lastKnownPowerKw[deviceId] || 0;
        if (measuredKw > previousPeak) {
            this.powerState.lastKnownPowerKw[deviceId] = measuredKw;
            this.logger.debug(`Power estimate: updated peak power for ${deviceLabel}: ${measuredKw.toFixed(3)} kW (was ${previousPeak.toFixed(3)} kW)`);
        }
    }

    private applyMeasurementUpdates(deviceId: string, updates: PowerMeasurementUpdates, deviceLabel: string): void {
        if (updates.lastMeterEnergyKwh) {
            this.powerState.lastMeterEnergyKwh[deviceId] = updates.lastMeterEnergyKwh;
        }
        if (updates.lastMeasuredPowerKw) {
            this.powerState.lastMeasuredPowerKw[deviceId] = updates.lastMeasuredPowerKw;
            this.updateLastKnownPower(deviceId, updates.lastMeasuredPowerKw.kw, deviceLabel);
        }
    }

    private resolveHomeyInstance(homey: Homey.App): Homey.App['homey'] {
        if (this.isHomeyAppWrapper(homey)) {
            return homey.homey;
        }
        return homey as unknown as Homey.App['homey'];
    }

    private isHomeyAppWrapper(value: unknown): value is { homey: Homey.App['homey'] } {
        return typeof value === 'object' && value !== null && 'homey' in value;
    }

    private async getRawDevices(path: string): Promise<Record<string, HomeyDeviceLike> | HomeyDeviceLike[]> {
        const api = this.extractHomeyApi(this.homey);
        if (!api?.get) {
            throw new Error('Homey API client not available');
        }
        const data = await api.get(path);
        if (Array.isArray(data)) return data as HomeyDeviceLike[];
        if (typeof data === 'object' && data !== null) return data as Record<string, HomeyDeviceLike>;
        return [];
    }

    private extractHomeyApi(homey: Homey.App): { get?: (path: string) => Promise<unknown> } | undefined {
        const homeyInstance = this.resolveHomeyInstance(homey);
        return (homeyInstance as { api?: { get?: (path: string) => Promise<unknown> } }).api;
    }

    private writeErrorToStderr(message: string, error: unknown): void {
        const stderr = typeof process !== 'undefined' ? process.stderr : undefined;
        if (!stderr || typeof stderr.write !== 'function') return;
        const errorText = error instanceof Error
            ? (error.stack || error.message)
            : String(error);
        try {
            stderr.write(`[PelsApp] ${message} ${errorText}\n`);
        } catch (_) {
            // ignore stderr failures
        }
    }
}
