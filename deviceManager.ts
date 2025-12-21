import Homey from 'homey';
import { HomeyDeviceLike, Logger, TargetDeviceSnapshot } from './types';

type HomeyApiConstructor = {
    createAppAPI: (opts: { homey: Homey.App['homey']; debug?: ((...args: unknown[]) => void) | null }) => Promise<HomeyApiClient>;
};
const { HomeyAPI } = require('homey-api') as { HomeyAPI: HomeyApiConstructor };

const TARGET_CAPABILITY_PREFIXES = ['target_temperature', 'thermostat_setpoint'];
const MIN_SIGNIFICANT_POWER_W = 50;

type HomeyApiDevicesClient = {
    getDevices?: () => Promise<Record<string, HomeyDeviceLike> | HomeyDeviceLike[]>;
    setCapabilityValue?: (args: { deviceId: string; capabilityId: string; value: unknown }) => Promise<void>;
    getDevice?: (args: { id: string }) => Promise<unknown>;
};

type HomeyApiClient = {
    devices?: HomeyApiDevicesClient;
};

type PowerEstimateState = {
    expectedPowerKwOverrides?: Record<string, { kw: number; ts: number }>;
    lastKnownPowerKw?: Record<string, number>;
    lastMeasuredPowerKw?: Record<string, { kw: number; ts: number }>;
};

type CapabilityValue = { value?: unknown; units?: string };

type PowerEstimateResult = {
    powerKw?: number;
    expectedPowerKw?: number;
    expectedPowerSource?: TargetDeviceSnapshot['expectedPowerSource'];
    measuredPowerKw?: number;
    loadKw?: number;
};

export class DeviceManager {
    private homeyApi?: HomeyApiClient;
    private logger: Logger;
    private homey: Homey.App;
    private latestSnapshot: TargetDeviceSnapshot[] = [];
    private powerState: Required<PowerEstimateState>;

    private providers: {
        getPriority?: (deviceId: string) => number;
        getControllable?: (deviceId: string) => boolean;
    } = {};

    constructor(homey: Homey.App, logger: Logger, providers?: {
        getPriority?: (deviceId: string) => number;
        getControllable?: (deviceId: string) => boolean;
    }, powerState?: PowerEstimateState) {
        this.homey = homey;
        this.logger = logger;
        if (providers) this.providers = providers;
        this.powerState = {
            expectedPowerKwOverrides: powerState?.expectedPowerKwOverrides ?? {},
            lastKnownPowerKw: powerState?.lastKnownPowerKw ?? {},
            lastMeasuredPowerKw: powerState?.lastMeasuredPowerKw ?? {},
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
        const list = await this.fetchDevices();
        const snapshot = this.parseDeviceList(list);
        this.latestSnapshot = snapshot;
        this.logger.debug(`Device snapshot refreshed: ${snapshot.length} devices found`);
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
        const devicesApi = this.homeyApi?.devices;
        if (devicesApi?.getDevices) {
            try {
                const devicesObj = await devicesApi.getDevices();
                const list = Array.isArray(devicesObj) ? devicesObj : Object.values(devicesObj || {});
                this.logger.debug(`HomeyAPI returned ${list.length} devices`);
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
    }

    private parseDeviceList(list: HomeyDeviceLike[]): TargetDeviceSnapshot[] {
        const now = Date.now();
        return list
            .map((device) => this.parseDevice(device, now))
            .filter(Boolean) as TargetDeviceSnapshot[];
    }

    private parseDevice(device: HomeyDeviceLike, now: number): TargetDeviceSnapshot | null {
        const deviceId = this.getDeviceId(device);
        if (!deviceId) {
            this.logger.error('Device missing ID, skipping:', device.name || 'unknown');
            return null;
        }
        const deviceLabel = this.getDeviceLabel(device, deviceId);
        const capabilities = this.getCapabilities(device);
        const capabilityObj = this.getCapabilityObj(device);
        const currentTemperature = this.getCurrentTemperature(capabilityObj);
        const powerRaw = capabilityObj.measure_power?.value;
        const powerEstimate = this.getPowerEstimate({
            device,
            deviceId,
            deviceLabel,
            powerRaw,
            now,
        });
        const targetCaps = this.getTargetCaps(capabilities);
        if (targetCaps.length === 0) {
            return null;
        }
        const targets = this.buildTargets(targetCaps, capabilityObj);
        const currentOn = this.getCurrentOn(capabilityObj, powerRaw);
        const zone = this.getZoneLabel(device);

        return {
            id: deviceId,
            name: device.name ?? deviceId,
            targets,
            powerKw: powerEstimate.powerKw,
            expectedPowerKw: powerEstimate.expectedPowerKw,
            expectedPowerSource: powerEstimate.expectedPowerSource,
            loadKw: powerEstimate.loadKw,
            priority: this.providers.getPriority ? this.providers.getPriority(deviceId) : undefined,
            currentOn,
            currentTemperature,
            measuredPowerKw: powerEstimate.measuredPowerKw,
            zone,
            controllable: this.providers.getControllable ? this.providers.getControllable(deviceId) : undefined,
            capabilities,
        };
    }

    private getDeviceId(device: HomeyDeviceLike): string | null {
        return device.id || device.data?.id || null;
    }

    private getDeviceLabel(device: HomeyDeviceLike, deviceId: string): string {
        return device.name ? `${device.name} (${deviceId})` : deviceId;
    }

    private getCapabilities(device: HomeyDeviceLike): string[] {
        return Array.isArray(device.capabilities) ? device.capabilities : [];
    }

    private getCapabilityObj(device: HomeyDeviceLike): Record<string, CapabilityValue> {
        if (device.capabilitiesObj && typeof device.capabilitiesObj === 'object') {
            return device.capabilitiesObj as Record<string, CapabilityValue>;
        }
        return {};
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

    private getCurrentOn(capabilityObj: Record<string, CapabilityValue>, powerRaw: unknown): boolean | undefined {
        if (typeof capabilityObj.onoff?.value === 'boolean') {
            return capabilityObj.onoff.value;
        }
        if (typeof powerRaw === 'number' && powerRaw > 50) {
            return true;
        }
        return undefined;
    }

    private getZoneLabel(device: HomeyDeviceLike): string {
        const zone = device.zone;
        if (zone && typeof zone === 'object' && 'name' in zone) {
            const name = (zone as { name?: unknown }).name;
            if (typeof name === 'string' && name) {
                return name;
            }
        }
        if (typeof zone === 'string' && zone) {
            return zone;
        }
        const zoneName = device.zoneName;
        if (typeof zoneName === 'string' && zoneName) {
            return zoneName;
        }
        return 'Unknown';
    }

    private getPowerEstimate(params: {
        device: HomeyDeviceLike;
        deviceId: string;
        deviceLabel: string;
        powerRaw: unknown;
        now: number;
    }): PowerEstimateResult {
        const { device, deviceId, deviceLabel, powerRaw, now } = params;
        const loadW = this.getLoadSettingWatts(device);
        const expectedOverride = this.powerState.expectedPowerKwOverrides[deviceId];

        if (loadW !== null) {
            return this.getPowerFromLoad({
                deviceId,
                deviceLabel,
                loadW,
                expectedOverride,
            });
        }
        return this.getPowerFromMeasurement({
            deviceId,
            deviceLabel,
            powerRaw,
            expectedOverride,
            now,
        });
    }

    private getLoadSettingWatts(device: HomeyDeviceLike): number | null {
        const loadW = typeof device.settings?.load === 'number' ? device.settings.load : null;
        return loadW && loadW > 0 ? loadW : null;
    }

    private getPowerFromLoad(params: {
        deviceId: string;
        deviceLabel: string;
        loadW: number;
        expectedOverride?: { kw: number; ts: number };
    }): PowerEstimateResult {
        const { deviceId, deviceLabel, loadW, expectedOverride } = params;
        const loadKw = loadW / 1000;
        this.updateLastKnownPower(deviceId, loadKw, deviceLabel);

        if (expectedOverride) {
            this.logger.debug(`Power estimate: using override (manual) for ${deviceLabel}: ${expectedOverride.kw.toFixed(3)} kW`);
            return {
                powerKw: expectedOverride.kw,
                expectedPowerKw: expectedOverride.kw,
                expectedPowerSource: 'manual',
                loadKw,
            };
        }
        this.logger.debug(`Power estimate: using settings.load for ${deviceLabel}: ${loadKw.toFixed(3)} kW`);
        return {
            powerKw: loadKw,
            expectedPowerKw: loadKw,
            expectedPowerSource: 'load-setting',
            loadKw,
        };
    }

    private getPowerFromMeasurement(params: {
        deviceId: string;
        deviceLabel: string;
        powerRaw: unknown;
        expectedOverride?: { kw: number; ts: number };
        now: number;
    }): PowerEstimateResult {
        const { deviceId, deviceLabel, powerRaw, expectedOverride, now } = params;
        const measured = this.getMeasuredPowerKw({
            deviceId,
            deviceLabel,
            powerRaw,
            now,
        });
        const peak = this.powerState.lastKnownPowerKw[deviceId];

        if (expectedOverride) {
            return this.resolveOverrideEstimate({
                deviceLabel,
                expectedOverride,
                measuredKw: measured.measuredKw,
            });
        }
        if (peak) {
            this.logger.debug(`Power estimate: using peak measured for ${deviceLabel}: ${peak.toFixed(3)} kW`);
            return {
                powerKw: peak,
                expectedPowerKw: peak,
                expectedPowerSource: 'measured-peak',
                measuredPowerKw: measured.measuredPowerKw,
            };
        }
        this.logger.debug(`Power estimate: fallback 1 kW for ${deviceLabel} (no measured/override/load)`);
        return {
            powerKw: 1,
            expectedPowerKw: undefined,
            expectedPowerSource: 'default',
            measuredPowerKw: measured.measuredPowerKw,
        };
    }

    private getMeasuredPowerKw(params: {
        deviceId: string;
        deviceLabel: string;
        powerRaw: unknown;
        now: number;
    }): { measuredKw?: number; measuredPowerKw?: number } {
        const { deviceId, deviceLabel, powerRaw, now } = params;
        if (typeof powerRaw !== 'number' || !Number.isFinite(powerRaw)) {
            return {};
        }
        if (powerRaw > MIN_SIGNIFICANT_POWER_W) {
            const measuredKw = powerRaw / 1000;
            this.powerState.lastMeasuredPowerKw[deviceId] = { kw: measuredKw, ts: now };
            this.updateLastKnownPower(deviceId, measuredKw, deviceLabel);
            return { measuredKw, measuredPowerKw: measuredKw };
        }
        this.logger.debug(`Power estimate: ignoring low reading for ${deviceLabel}: ${powerRaw} W`);
        return {};
    }

    private resolveOverrideEstimate(params: {
        deviceLabel: string;
        expectedOverride: { kw: number; ts: number };
        measuredKw?: number;
    }): PowerEstimateResult {
        const { deviceLabel, expectedOverride, measuredKw } = params;
        const measuredValue = measuredKw ?? 0;
        if (measuredKw !== undefined && measuredValue > expectedOverride.kw) {
            this.logger.debug(`Power estimate: current ${measuredValue.toFixed(3)} kW > override ${expectedOverride.kw.toFixed(3)} kW for ${deviceLabel}`);
            return {
                powerKw: measuredValue,
                expectedPowerKw: measuredValue,
                expectedPowerSource: 'measured-peak',
                measuredPowerKw: measuredKw,
            };
        }
        this.logger.debug(`Power estimate: using override for ${deviceLabel}: ${expectedOverride.kw.toFixed(3)} kW`);
        return {
            powerKw: expectedOverride.kw,
            expectedPowerKw: expectedOverride.kw,
            expectedPowerSource: 'manual',
            measuredPowerKw: measuredKw,
        };
    }

    private updateLastKnownPower(deviceId: string, measuredKw: number, deviceLabel: string): void {
        const previousPeak = this.powerState.lastKnownPowerKw[deviceId] || 0;
        if (measuredKw > previousPeak) {
            this.powerState.lastKnownPowerKw[deviceId] = measuredKw;
            this.logger.debug(`Power estimate: updated peak power for ${deviceLabel}: ${measuredKw.toFixed(3)} kW (was ${previousPeak.toFixed(3)} kW)`);
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
}
