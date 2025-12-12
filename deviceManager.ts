import Homey from 'homey';
import { Logger, TargetDeviceSnapshot } from './types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HomeyAPI } = require('homey-api');

const TARGET_CAPABILITY_PREFIXES = ['target_temperature', 'thermostat_setpoint'];
const MIN_SIGNIFICANT_POWER_W = 50;

type PowerEstimateState = {
    expectedPowerKwOverrides?: Record<string, { kw: number; ts: number }>;
    lastKnownPowerKw?: Record<string, number>;
    lastMeasuredPowerKw?: Record<string, { kw: number; ts: number }>;
};

export class DeviceManager {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private homeyApi?: any;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parseDeviceListForTests(list: any[]): TargetDeviceSnapshot[] {
        return this.parseDeviceList(list);
    }

    async init(): Promise<void> {
        if (this.homeyApi) return;

        // Access the underlying Homey instance from the App instance
        // In real app and MockApp, this is this.homey.homey
        // In unit tests with POJO mock, this.homey IS the Homey instance mock
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const homeyInstance = (this.homey as any).homey || this.homey as any;

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
        if (!this.homeyApi || !this.homeyApi.devices) throw new Error('HomeyAPI not ready');

        await this.homeyApi.devices.setCapabilityValue({
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async fetchDevices(): Promise<any[]> {
        if (this.homeyApi?.devices) {
            try {
                const devicesObj = await this.homeyApi.devices.getDevices();
                this.logger.debug(`HomeyAPI returned ${Object.keys(devicesObj || {}).length} devices`);
                return Object.values(devicesObj || {});
            } catch (error) {
                this.logger.debug('HomeyAPI.getDevices failed, falling back to raw API', error as Error);
            }
        }

        // Fallback to manager/devices then /devices
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const devices: any = await (this.homey as any).api?.get?.('manager/devices');
            const list = Array.isArray(devices) ? devices : Object.values(devices || {});
            this.logger.debug(`Manager API returned ${list.length} devices`);
            return list;
        } catch (err) {
            this.logger.debug('Manager API manager/devices failed, retrying devices', err as Error);
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const devices: any = await (this.homey as any).api?.get?.('devices');
                const list = Array.isArray(devices) ? devices : Object.values(devices || {});
                this.logger.debug(`Manager API devices returned ${list.length} devices`);
                return list;
            } catch (error) {
                this.logger.debug('Manager API devices failed as well', error as Error);
                return [];
            }
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, max-len -- Homey device objects have no TypeScript definitions
    private parseDeviceList(list: any[]): TargetDeviceSnapshot[] {
        const now = Date.now();
        return list
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((device: any) => {
                const deviceId = device.id || device.data?.id;
                if (!deviceId) {
                    this.logger.error('Device missing ID, skipping:', device.name || 'unknown');
                    return null;
                }

                const capabilities: string[] = device.capabilities || [];
                const capabilityObj = device.capabilitiesObj || {};
                const currentTemperature = typeof capabilityObj.measure_temperature?.value === 'number'
                    ? capabilityObj.measure_temperature.value
                    : undefined;
                const powerRaw = capabilityObj.measure_power?.value;
                const isOn = capabilityObj.onoff?.value === true;
                let powerKw: number | undefined;
                let expectedPowerKw: number | undefined;
                const expectedOverride = this.powerState.expectedPowerKwOverrides[deviceId];
                let measuredPowerKw: number | undefined;
                const deviceLabel = device.name ? `${device.name} (${deviceId})` : deviceId;

                // Priority for power estimates:
                // 1. settings.load (configured expected load)
                // 2. Most recent of:
                //    - measured power (measure_power), tracked with timestamp
                //    - expectedPowerKwOverrides (temporary override set via flow)
                // 3. Default fallback: 1 kW
                const loadW = typeof device.settings?.load === 'number' ? device.settings.load : undefined;
                if (loadW && loadW > 0) {
                    powerKw = loadW / 1000;
                    expectedPowerKw = powerKw;
                    this.powerState.lastKnownPowerKw[deviceId] = powerKw;
                    this.logger.debug(`Power estimate: using settings.load for ${deviceLabel}: ${powerKw.toFixed(3)} kW`);
                } else {
                    if (typeof powerRaw === 'number' && Number.isFinite(powerRaw) && powerRaw <= MIN_SIGNIFICANT_POWER_W) {
                        this.logger.debug(`Power estimate: ignoring low reading for ${deviceLabel}: ${powerRaw} W (<= ${MIN_SIGNIFICANT_POWER_W} W threshold)`);
                    }
                    if (typeof powerRaw === 'number' && Number.isFinite(powerRaw) && powerRaw > MIN_SIGNIFICANT_POWER_W) {
                        const measuredKw = powerRaw / 1000;
                        measuredPowerKw = measuredKw;
                        this.powerState.lastMeasuredPowerKw[deviceId] = { kw: measuredKw, ts: now };
                        // Track this as the last known power for this device (when on and drawing)
                        if (isOn && measuredKw > MIN_SIGNIFICANT_POWER_W / 1000) {
                            this.powerState.lastKnownPowerKw[deviceId] = measuredKw;
                        }
                        this.logger.debug(`Power estimate: captured measured power for ${deviceLabel}: ${measuredKw.toFixed(3)} kW`);
                    }

                    const measured = this.powerState.lastMeasuredPowerKw[deviceId];
                    if (!measuredPowerKw && measured) {
                        measuredPowerKw = measured.kw;
                    }
                    const override = expectedOverride;
                    if (measured && (!override || measured.ts >= override.ts)) {
                        powerKw = measured.kw;
                        expectedPowerKw = measured.kw;
                        this.logger.debug(`Power estimate: using last measured for ${deviceLabel}: ${measured.kw.toFixed(3)} kW`);
                    } else if (override) {
                        powerKw = override.kw;
                        expectedPowerKw = override.kw;
                        this.logger.debug(`Power estimate: using override for ${deviceLabel}: ${override.kw.toFixed(3)} kW`);
                    } else {
                        powerKw = 1;
                        expectedPowerKw = undefined; // Unknown estimate shown as "Unknown" in UI
                        this.logger.debug(`Power estimate: fallback 1 kW for ${deviceLabel} (no measured/override/load)`);
                    }
                }

                const targetCaps = capabilities.filter((cap) => TARGET_CAPABILITY_PREFIXES.some((prefix) => cap.startsWith(prefix)));
                if (targetCaps.length === 0) {
                    return null;
                }

                const targets = targetCaps.map((capId) => ({
                    id: capId,
                    value: capabilityObj[capId]?.value ?? null,
                    unit: capabilityObj[capId]?.units || '°C',
                }));

                // Determine if device is ON:
                // 1. Check explicit onoff capability
                // 2. Fall back to checking if device is drawing significant power (>50W)
                let currentOn: boolean | undefined;
                if (typeof capabilityObj.onoff?.value === 'boolean') {
                    currentOn = capabilityObj.onoff.value;
                } else if (typeof powerRaw === 'number' && powerRaw > 50) {
                    currentOn = true;
                }

                return {
                    id: deviceId,
                    name: device.name,
                    targets,
                    powerKw,
                    expectedPowerKw,
                    loadKw: loadW && loadW > 0 ? loadW / 1000 : undefined,
                    priority: this.providers.getPriority ? this.providers.getPriority(deviceId) : undefined,
                    currentOn,
                    currentTemperature,
                    measuredPowerKw,
                    zone: device.zone?.name
                        || (typeof device.zone === 'string' ? device.zone : undefined)
                        || device.zoneName
                        || 'Unknown',
                    controllable: this.providers.getControllable ? this.providers.getControllable(deviceId) : undefined,
                    capabilities,
                };
            })
            .filter(Boolean) as TargetDeviceSnapshot[];
    }
}
