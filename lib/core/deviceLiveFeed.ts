/*
 * Device live feed adapter using Homey's local Web API socket.io subscription.
 *
 * Root cause of the missing live updates (prior to this module):
 * PR "Remove homey-api dependency" (commit e6190db) replaced the homey-api library
 * with a fallback using homey.api.getApi('homey:manager:devices').on('realtime', ...).
 * That SDK path is the app<->settings-page messaging channel, NOT a manager event bus.
 * It never fires device updates. Live updates previously worked via the homey-api
 * library's socket.io client against the local HTTP API.
 *
 * Protocol (reverse-engineered from homey-api HomeyAPIV3.js):
 *   1. socket.io connect to <baseUrl>, websocket transport, autoConnect=false
 *   2. on connect: emit('handshakeClient', { token, homeyId }) → { namespace }
 *   3. open sub-socket at namespace (e.g. '/api'), wait for connect
 *   4. emit('subscribe', 'homey:manager:devices') → ack
 *   5. sub-socket emits events as: .on('homey:manager:devices', (eventName, data) => ...)
 *      where eventName is 'device.update', 'device.create', 'device.delete'
 *      and data is a full HomeyDeviceLike object including capabilitiesObj with live values
 *
 * Per-device capability events (homey:device:{id}):
 *   After subscribing to homey:manager:devices, we also subscribe to homey:device:{id}
 *   for each tracked device. Events arrive as (eventName='capability', data) where
 *   data = { capabilityId, value, transactionId?, transactionTime? }.
 *   These fire on every API write — immediately when the user changes a device via
 *   the Homey app, without waiting for device hardware confirmation. This is how
 *   homey-api's makeCapabilityInstance() worked internally.
 *
 * Note: no targeted HTTP fetch is needed — the device.update payload already contains
 * capabilitiesObj with current values and lastUpdated timestamps, equivalent to a snapshot.
 */
import type Homey from 'homey';
import { io, type Manager as SocketIOManager, type Socket as SocketIOSocket } from 'socket.io-client';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import { resolveHomeyInstance } from './deviceManagerHomeyApi';
import { normalizeError } from '../utils/errorUtils';

const DEVICES_URI = 'homey:manager:devices';
const DEVICE_UPDATE_EVENT = 'device.update';
const DEVICE_CAPABILITY_EVENT = 'capability';
const DEVICE_URI_PREFIX = 'homey:device:';
const HANDSHAKE_TIMEOUT_MS = 15_000;
const SUBSCRIBE_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 5_000;
const RECONNECT_DELAY_MAX_MS = 60_000;
const QUIET_FEED_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const QUIET_CHECK_INTERVAL_MS = 60 * 1000;

export type LiveFeedHealth = {
  subscriptionState: 'disconnected' | 'connecting' | 'connected' | 'subscribed';
  lastLiveEventMs: number | null;
  liveEventCount: number;
  ignoredLiveEventCount: number;
  reconnectCount: number;
  lastReconnectMs: number | null;
  lastSuccessfulSubscriptionMs: number | null;
};

export type DeviceLiveFeed = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isHealthy: () => boolean;
  getHealth: () => LiveFeedHealth;
  /** Update the set of device IDs to subscribe to for per-capability events. Fire-and-forget. */
  updateTrackedDevices: (deviceIds: readonly string[]) => void;
};

type HandshakeResult = { namespace: string };

type FeedCallbacks = {
  onDeviceUpdate: (device: HomeyDeviceLike) => void;
  onCapabilityUpdate?: (deviceId: string, capabilityId: string, value: unknown) => void;
};

type ConnectionDetails = {
  baseUrl: string;
  token: string;
  homeyId: string;
};

class DeviceLiveFeedImpl implements DeviceLiveFeed {
  private readonly logger: Logger;
  private readonly callbacks: FeedCallbacks;
  private readonly homeyInstance: ReturnType<typeof resolveHomeyInstance>;

  private rootSocket: SocketIOSocket | null = null;
  private namespacedSocket: SocketIOSocket | null = null;
  private stopped = false;
  private quietCheckTimer: ReturnType<typeof setInterval> | null = null;
  private quietEmittedAt: number | null = null;
  private trackedDeviceIds: ReadonlySet<string> = new Set();
  private subscribedDeviceIds: Set<string> = new Set();

  private health: LiveFeedHealth = {
    subscriptionState: 'disconnected',
    lastLiveEventMs: null,
    liveEventCount: 0,
    ignoredLiveEventCount: 0,
    reconnectCount: 0,
    lastReconnectMs: null,
    lastSuccessfulSubscriptionMs: null,
  };

  constructor(params: { homey: Homey.App; logger: Logger; callbacks: FeedCallbacks }) {
    this.logger = params.logger;
    this.callbacks = params.callbacks;
    this.homeyInstance = resolveHomeyInstance(params.homey);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.startQuietFeedMonitor();
    try {
      await this.connect();
    } catch (error) {
      this.health.subscriptionState = 'disconnected';
      this.logger.structuredLog?.error({
        component: 'devices',
        source: 'web_api_subscription',
        event: 'device_live_feed_connect_failed',
        err: normalizeError(error),
        subscriptionState: this.health.subscriptionState,
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.quietCheckTimer) {
      clearInterval(this.quietCheckTimer);
      this.quietCheckTimer = null;
    }
    this.subscribedDeviceIds.clear();
    try {
      this.namespacedSocket?.removeAllListeners();
      this.namespacedSocket?.disconnect();
    } catch { /* ignore */ }
    try {
      this.rootSocket?.removeAllListeners();
      this.rootSocket?.disconnect();
    } catch { /* ignore */ }
    this.rootSocket = null;
    this.namespacedSocket = null;
    this.health.subscriptionState = 'disconnected';
    this.logger.structuredLog?.info({
      component: 'devices',
      source: 'web_api_subscription',
      event: 'device_live_feed_stopped',
      liveEventCount: this.health.liveEventCount,
      ignoredLiveEventCount: this.health.ignoredLiveEventCount,
      reconnectCount: this.health.reconnectCount,
    });
  }

  isHealthy(): boolean {
    return this.health.subscriptionState === 'subscribed';
  }

  getHealth(): LiveFeedHealth {
    return { ...this.health };
  }

  updateTrackedDevices(deviceIds: readonly string[]): void {
    const nextSet = new Set(deviceIds);
    this.trackedDeviceIds = nextSet;
    if (!this.namespacedSocket?.connected) return;
    void this.syncDeviceSubscriptions(nextSet);
  }

  private async resolveConnectionDetails(): Promise<ConnectionDetails | null> {
    const api = (this.homeyInstance as {
      api?: {
        getOwnerApiToken?: () => Promise<string>;
        getLocalUrl?: () => Promise<string>;
      };
    }).api;
    const cloud = (this.homeyInstance as {
      cloud?: { getHomeyId?: () => Promise<string> };
    }).cloud;
    if (!api?.getOwnerApiToken || !api?.getLocalUrl || !cloud?.getHomeyId) return null;
    const [token, baseUrl, homeyId] = await Promise.all([
      api.getOwnerApiToken(),
      api.getLocalUrl(),
      cloud.getHomeyId(),
    ]);
    if (!token || !baseUrl || !homeyId) return null;
    return { baseUrl, token, homeyId };
  }

  private async connect(): Promise<void> {
    this.health.subscriptionState = 'connecting';
    const details = await this.resolveConnectionDetails();
    if (!details) {
      this.health.subscriptionState = 'disconnected';
      this.logger.structuredLog?.info({
        component: 'devices',
        source: 'web_api_subscription',
        event: 'device_live_feed_stopped',
        reason: 'prerequisites_missing',
      });
      return;
    }
    const { baseUrl, token, homeyId } = details;
    this.logger.structuredLog?.info({
      component: 'devices',
      source: 'web_api_subscription',
      event: 'device_live_feed_started',
      baseUrl,
      subscriptionState: this.health.subscriptionState,
    });

    this.rootSocket = io(baseUrl, {
      autoConnect: false,
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: RECONNECT_DELAY_MS,
      reconnectionDelayMax: RECONNECT_DELAY_MAX_MS,
    });

    this.rootSocket.on('disconnect', (reason: string) => {
      this.health.subscriptionState = 'disconnected';
      if (!this.stopped) {
        this.health.reconnectCount += 1;
        this.health.lastReconnectMs = Date.now();
        this.logger.structuredLog?.info({
          component: 'devices', source: 'web_api_subscription',
          event: 'device_live_feed_reconnect_scheduled',
          reason, reconnectAttempt: this.health.reconnectCount,
          subscriptionState: this.health.subscriptionState,
        });
      }
    });

    this.rootSocket.io.on('reconnect', () => {
      if (this.stopped) return;
      this.logger.structuredLog?.info({
        component: 'devices', source: 'web_api_subscription',
        event: 'device_live_feed_reconnected',
        reconnectAttempt: this.health.reconnectCount,
        subscriptionState: this.health.subscriptionState,
      });
      void this.resubscribe(details);
    });

    this.rootSocket.on('connect_error', (err: Error) => {
      this.logger.structuredLog?.error({
        component: 'devices', source: 'web_api_subscription',
        event: 'device_live_feed_connect_error',
        err: normalizeError(err), subscriptionState: this.health.subscriptionState,
      });
    });

    await this.waitForRootConnect(baseUrl);
    if (this.stopped) return;
    await this.handshakeAndSubscribe({ token, homeyId });
  }

  private async waitForRootConnect(baseUrl: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`root connect timeout after ${HANDSHAKE_TIMEOUT_MS}ms`));
      }, HANDSHAKE_TIMEOUT_MS);
      this.rootSocket!.once('connect', () => { clearTimeout(timer); resolve(); });
      this.rootSocket!.once('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
      this.rootSocket!.connect();
    });
    this.logger.structuredLog?.info({
      component: 'devices', source: 'web_api_subscription',
      event: 'device_live_feed_root_connected', baseUrl,
    });
    this.health.subscriptionState = 'connected';
  }

  private async handshakeAndSubscribe(args: { token: string; homeyId: string }): Promise<void> {
    const handshake = await this.emitHandshake(args);
    // Tear down the old socket BEFORE opening a new one — Manager caches sockets by namespace,
    // so disconnecting after would kill the newly created socket.
    if (this.namespacedSocket) {
      this.subscribedDeviceIds.clear();
      this.namespacedSocket.removeAllListeners();
      this.namespacedSocket.disconnect();
      this.namespacedSocket = null;
    }
    const sub = this.openNamespacedSocket(handshake.namespace);
    this.namespacedSocket = sub;
    await this.waitForNamespaceConnect(sub, handshake.namespace);
    if (this.stopped) return;
    await this.emitSubscribeUri(sub, DEVICES_URI);
    if (this.stopped) return;
    this.health.subscriptionState = 'subscribed';
    this.health.lastSuccessfulSubscriptionMs = Date.now();
    this.attachDeviceUpdateListener(sub);
    this.logger.structuredLog?.info({
      component: 'devices', source: 'web_api_subscription',
      event: 'device_live_feed_started',
      namespace: handshake.namespace, uri: DEVICES_URI,
      subscriptionState: this.health.subscriptionState,
    });
    void this.syncDeviceSubscriptions(this.trackedDeviceIds);
  }

  private async resubscribe(details: ConnectionDetails): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.rootSocket?.connected) {
        await this.handshakeAndSubscribe(details);
      }
    } catch (error) {
      this.logger.structuredLog?.error({
        component: 'devices', source: 'web_api_subscription',
        event: 'device_live_feed_reconnect_failed',
        err: normalizeError(error),
        reconnectAttempt: this.health.reconnectCount,
      });
    }
  }

  private async emitHandshake(args: { token: string; homeyId: string }): Promise<HandshakeResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`handshakeClient timeout after ${HANDSHAKE_TIMEOUT_MS}ms`));
      }, HANDSHAKE_TIMEOUT_MS);
      this.rootSocket!.emit('handshakeClient', args, (err: unknown, result: HandshakeResult | undefined) => {
        clearTimeout(timer);
        if (err) {
          reject(err instanceof Error ? err : new Error(String((err as { message?: string }).message ?? err)));
          return;
        }
        if (!result || typeof result.namespace !== 'string') {
          reject(new Error('handshakeClient returned no namespace'));
          return;
        }
        resolve(result);
      });
    });
  }

  private openNamespacedSocket(namespace: string): SocketIOSocket {
    const manager = (this.rootSocket as unknown as { io: SocketIOManager }).io;
    const sub = manager.socket(namespace);
    sub.open();
    return sub;
  }

  private async waitForNamespaceConnect(sub: SocketIOSocket, namespace: string): Promise<void> {
    if (sub.connected) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`namespace ${namespace} connect timeout after ${HANDSHAKE_TIMEOUT_MS}ms`));
      }, HANDSHAKE_TIMEOUT_MS);
      sub.once('connect', () => { clearTimeout(timer); resolve(); });
      sub.once('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
    });
  }

  private async emitSubscribeUri(sub: SocketIOSocket, uri: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`subscribe(${uri}) timeout after ${SUBSCRIBE_TIMEOUT_MS}ms`));
      }, SUBSCRIBE_TIMEOUT_MS);
      sub.emit('subscribe', uri, (err: unknown) => {
        clearTimeout(timer);
        if (err) {
          reject(err instanceof Error ? err : new Error(String((err as { message?: string }).message ?? err)));
          return;
        }
        resolve();
      });
    });
  }

  private attachDeviceUpdateListener(sub: SocketIOSocket): void {
    sub.on(DEVICES_URI, (eventName: string, data: unknown) => {
      this.health.lastLiveEventMs = Date.now();
      this.quietEmittedAt = null;
      this.logger.structuredLog?.debug({
        component: 'devices', source: 'web_api_subscription',
        event: 'device_live_feed_event_received',
        eventName, deviceId: extractDeviceId(data),
        subscriptionState: this.health.subscriptionState,
      });
      if (eventName !== DEVICE_UPDATE_EVENT) {
        this.health.ignoredLiveEventCount += 1;
        this.logger.structuredLog?.info({
          component: 'devices', source: 'web_api_subscription',
          event: 'device_live_feed_event_ignored',
          eventName, ignoreReason: 'not_device_update',
          ignoredLiveEventCount: this.health.ignoredLiveEventCount,
        });
        return;
      }
      if (!data || typeof data !== 'object') {
        this.health.ignoredLiveEventCount += 1;
        this.logger.structuredLog?.info({
          component: 'devices', source: 'web_api_subscription',
          event: 'device_live_feed_event_ignored',
          eventName, ignoreReason: 'invalid_payload',
          ignoredLiveEventCount: this.health.ignoredLiveEventCount,
        });
        return;
      }
      this.health.liveEventCount += 1;
      this.callbacks.onDeviceUpdate(data as HomeyDeviceLike);
    });
  }

  private async syncDeviceSubscriptions(targetIds: ReadonlySet<string>): Promise<void> {
    for (const id of this.subscribedDeviceIds) {
      if (!targetIds.has(id)) this.unsubscribeFromDevice(id);
    }
    for (const id of targetIds) {
      if (!this.subscribedDeviceIds.has(id)) await this.subscribeToDevice(id);
    }
  }

  private async subscribeToDevice(deviceId: string): Promise<void> {
    if (!this.namespacedSocket?.connected || this.stopped) return;
    const uri = `${DEVICE_URI_PREFIX}${deviceId}`;
    try {
      await this.emitSubscribeUri(this.namespacedSocket, uri);
      this.subscribedDeviceIds.add(deviceId);
      this.namespacedSocket.on(uri, (eventName: string, data: unknown) => {
        if (eventName !== DEVICE_CAPABILITY_EVENT) return;
        if (!data || typeof data !== 'object') return;
        const payload = data as Record<string, unknown>;
        if (typeof payload.capabilityId !== 'string') return;
        this.callbacks.onCapabilityUpdate?.(deviceId, payload.capabilityId, payload.value);
      });
    } catch (error) {
      this.logger.structuredLog?.error({
        component: 'devices', source: 'web_api_subscription',
        event: 'device_live_feed_device_subscribe_failed',
        deviceId, err: normalizeError(error),
      });
    }
  }

  private unsubscribeFromDevice(deviceId: string): void {
    const uri = `${DEVICE_URI_PREFIX}${deviceId}`;
    this.namespacedSocket?.emit('unsubscribe', uri);
    this.namespacedSocket?.off(uri);
    this.subscribedDeviceIds.delete(deviceId);
  }

  private startQuietFeedMonitor(): void {
    this.quietCheckTimer = setInterval(() => {
      if (this.stopped) return;
      const now = Date.now();
      const lastEvent = this.health.lastLiveEventMs;
      const secondsSinceLastEvent = lastEvent ? Math.round((now - lastEvent) / 1000) : null;
      const isQuiet = lastEvent === null
        ? (this.health.lastSuccessfulSubscriptionMs !== null
          && now - this.health.lastSuccessfulSubscriptionMs > QUIET_FEED_THRESHOLD_MS)
        : now - lastEvent > QUIET_FEED_THRESHOLD_MS;
      const alreadyEmitted = this.quietEmittedAt !== null
        && (now - this.quietEmittedAt < QUIET_FEED_THRESHOLD_MS * 2);
      if (isQuiet && !alreadyEmitted) {
        this.quietEmittedAt = now;
        this.logger.structuredLog?.info({
          component: 'devices', source: 'web_api_subscription',
          event: 'device_live_feed_quiet',
          lastEventAt: lastEvent ? new Date(lastEvent).toISOString() : null,
          secondsSinceLastEvent, subscriptionState: this.health.subscriptionState,
          liveEventCount: this.health.liveEventCount,
        });
      }
    }, QUIET_CHECK_INTERVAL_MS);
  }
}

export function createDeviceLiveFeed(params: {
  homey: Homey.App;
  logger: Logger;
  callbacks: {
    onDeviceUpdate: (device: HomeyDeviceLike) => void;
    onCapabilityUpdate?: (deviceId: string, capabilityId: string, value: unknown) => void;
  };
}): DeviceLiveFeed {
  return new DeviceLiveFeedImpl(params);
}

function extractDeviceId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.id === 'string') return record.id;
  return undefined;
}
