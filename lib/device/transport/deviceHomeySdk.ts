import type Homey from 'homey';
import type { HomeyDeviceLike, Logger } from '../../utils/types';
import { getDebugEmitter } from '../../logging/logger';
import { normalizeError } from '../../utils/errorUtils';
import { createDeviceLiveFeed, type DeviceLiveFeed, type LiveFeedHealth } from '../liveFeed';
import { initHomeyHttpClient, resolveHomeyInstance } from './managerHomeyApi';
import {
  fetchDevicesByIds as fetchDevicesByIdsFromSdk,
  fetchDevicesWithFallback,
  type DeviceFetchResult,
} from './managerFetch';
import { addPerfDuration } from '../../utils/perfCounters';

const emitSdkDebug = getDebugEmitter('devices', 'devices');

/** Owns the Homey REST client and device realtime socket lifecycle. */
export class DeviceHomeySdk {
  private ready = false;
  private liveFeed: DeviceLiveFeed | null = null;

  constructor(
    private readonly homey: Homey.App,
    private readonly logger: Logger,
    private readonly onDeviceUpdate: (device: HomeyDeviceLike) => void,
    private readonly onCapabilityUpdate: (
      deviceId: string,
      capabilityId: string,
      value: unknown,
    ) => void,
  ) {}

  async initialize(): Promise<void> {
    if (this.ready) return;

    const homeyInstance = resolveHomeyInstance(this.homey);
    if (
      !homeyInstance?.api
      || typeof homeyInstance.api.getOwnerApiToken !== 'function'
      || typeof homeyInstance.api.getLocalUrl !== 'function'
      || !homeyInstance.cloud
      || typeof homeyInstance.cloud.getHomeyId !== 'function'
      || !homeyInstance.platform
      || !homeyInstance.platformVersion
    ) {
      this.logger.structuredLog.info({
        component: 'devices',
        event: 'device_api_init_skipped',
        reasonCode: 'sdk_api_missing',
        realtimeListenerAttached: false,
      });
      emitSdkDebug({ event: 'sdk_api_unavailable_skipping_init' });
      return;
    }

    try {
      await initHomeyHttpClient(this.homey);
    } catch (error) {
      this.logger.structuredLog.error({
        event: 'device_api_http_client_init_failed',
        reasonCode: 'http_client_init_failed',
        realtimeListenerAttached: false,
        err: normalizeError(error),
      });
      return;
    }

    this.ready = true;
    this.liveFeed = createDeviceLiveFeed({
      homey: this.homey,
      logger: this.logger,
      callbacks: {
        onDeviceUpdate: this.onDeviceUpdate,
        onCapabilityUpdate: this.onCapabilityUpdate,
      },
    });
    await this.liveFeed.start();
    this.logger.structuredLog.info({
      component: 'devices',
      event: 'device_api_initialized',
    });
  }

  async fetchDevices(): Promise<DeviceFetchResult> {
    const start = Date.now();
    try {
      return await fetchDevicesWithFallback({ logger: this.logger });
    } finally {
      const durationMs = Date.now() - start;
      addPerfDuration('device_fetch_ms', durationMs);
      addPerfDuration('device_fetch_full_ms', durationMs);
    }
  }

  async fetchDevicesByIds(deviceIds: string[]): Promise<DeviceFetchResult> {
    const start = Date.now();
    try {
      return await fetchDevicesByIdsFromSdk({ deviceIds, logger: this.logger });
    } finally {
      const durationMs = Date.now() - start;
      addPerfDuration('device_fetch_ms', durationMs);
      addPerfDuration('device_fetch_targeted_ms', durationMs);
    }
  }

  updateTrackedDevices(deviceIds: string[]): void {
    this.liveFeed?.updateTrackedDevices(deviceIds);
  }

  getHealth(): LiveFeedHealth | null {
    return this.liveFeed?.getHealth() ?? null;
  }

  stop(): void {
    void this.liveFeed?.stop();
    this.liveFeed = null;
    this.ready = false;
  }
}
