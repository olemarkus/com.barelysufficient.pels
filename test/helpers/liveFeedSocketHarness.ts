/**
 * The one socket.io fake behind every test that touches the device live feed
 * (`lib/device/liveFeed.ts`).
 *
 * `test/setup.ts` routes the global `socket.io-client` mock through
 * {@link liveFeedIo}. By default it refuses the connection, with no real I/O, so
 * the feed gives up at once and no test opens a websocket or runs the
 * subscribe flow by accident. A test that drives realtime device events calls
 * {@link connectLiveFeed} before `onInit()` / `transport.init()`: the next feed
 * then completes the handshake, subscribes to `homey:manager:devices`, and
 * subscribes per device as each committed refresh asks it to, exactly as it
 * would against a Homey. Frames then enter where Homey's would:
 *
 * - {@link emitCapability}: a `capability` frame on `homey:device:<id>`. Homey
 *   sends it only to a client subscribed to that device, which PELS is only for
 *   the devices of its last committed refresh plus the cars the EV link probe
 *   tracks. It throws when nothing is subscribed, so a test cannot inject into a
 *   device production would never hear from.
 *
 * `setup.ts` resets the mode after every test. `createLiveFeedSocketHarness`
 * is the lower-level socket pair for a spec that drives the feed itself and
 * acknowledges each device subscription by hand.
 */
// `test/setup.ts` imports this file, and a spec that mocks a Node builtin
// (`prices.test.ts` mocks `https`) loads the setup's imports through Node's own
// strip-only TypeScript loader. So: explicit `.ts` import extensions, and no
// syntax that loader cannot strip (no parameter properties, no enums).
import { EventEmitter } from 'node:events';
import type { Manager, Socket } from 'socket.io-client';
import { partialDouble } from './partialDouble.ts';

type Acknowledge = (error?: Error | null) => void;
type AcknowledgeMode = 'auto' | 'manual';

const DEVICES_URI = 'homey:manager:devices';
const deviceUri = (deviceId: string): string => `homey:device:${deviceId}`;

// Counts every subscribe request and acknowledgement, so `settleLiveFeed` can
// tell when the feed's subscription passes have stopped moving.
let subscriptionActivity = 0;

/** Socket boundary with explicit control of device subscription acknowledgements. */
class LiveFeedSocket {
  readonly events = new EventEmitter();
  readonly subscriptions: string[] = [];
  readonly unsubscriptions: string[] = [];
  readonly socket: Socket;
  private readonly pending = new Map<string, Acknowledge[]>();

  private readonly acknowledgeMode: AcknowledgeMode;

  constructor(acknowledgeMode: AcknowledgeMode, manager?: Manager) {
    this.acknowledgeMode = acknowledgeMode;
    this.events.setMaxListeners(0);
    this.socket = partialDouble<Socket>({
      ...(manager ? { io: manager } : {}),
      connected: false,
      on: (event, listener) => { this.events.on(event, listener); return this.socket; },
      once: (event, listener) => { this.events.once(event, listener); return this.socket; },
      off: (event, listener) => {
        if (event === undefined) this.events.removeAllListeners();
        else if (listener) this.events.off(event, listener);
        else this.events.removeAllListeners(event);
        return this.socket;
      },
      removeAllListeners: () => { this.events.removeAllListeners(); return this.socket; },
      connect: () => this.connect(),
      open: () => this.connect(),
      disconnect: () => { this.socket.connected = false; return this.socket; },
      emit: (event: string, ...args: unknown[]) => { this.send(event, args); return this.socket; },
    });
  }

  private connect(): Socket {
    this.socket.connected = true;
    queueMicrotask(() => this.events.emit('connect'));
    return this.socket;
  }

  private send(event: string, args: unknown[]): void {
    const ack = args.at(-1);
    if (event === 'handshakeClient' && typeof ack === 'function') {
      queueMicrotask(() => ack(null, { namespace: '/api' }));
    }
    if (event === 'subscribe' && typeof args[0] === 'string' && typeof ack === 'function') {
      const uri = args[0];
      subscriptionActivity += 1;
      if (uri === DEVICES_URI) {
        queueMicrotask(() => ack(null));
      } else {
        this.subscriptions.push(uri);
        const acknowledge: Acknowledge = (error) => {
          subscriptionActivity += 1;
          ack(error);
        };
        if (this.acknowledgeMode === 'auto') {
          queueMicrotask(() => acknowledge(null));
        } else {
          const pending = this.pending.get(uri) ?? [];
          pending.push(acknowledge);
          this.pending.set(uri, pending);
        }
      }
    }
    if (event === 'unsubscribe' && typeof args[0] === 'string') this.unsubscriptions.push(args[0]);
  }

  acknowledge(deviceId: string, error?: Error): void {
    const callbacks = this.pending.get(deviceUri(deviceId)) ?? [];
    this.pending.delete(deviceUri(deviceId));
    for (const callback of callbacks) callback(error);
  }

  takeAcknowledgement(deviceId: string): Acknowledge {
    const callback = this.pending.get(deviceUri(deviceId))?.shift();
    if (!callback) throw new Error(`No pending subscription for ${deviceId}`);
    return callback;
  }

  /** Deliver a frame on `uri`; whether any listener heard it. */
  deliver(uri: string, eventName: string, data: unknown): boolean {
    if (!this.socket.connected) return false;
    return this.events.emit(uri, eventName, data);
  }

  capability(deviceId: string, capabilityId = 'measure_power', value: unknown = 500): void {
    this.deliver(deviceUri(deviceId), 'capability', { capabilityId, value });
  }
}

export function createLiveFeedSocketHarness(acknowledgeMode: AcknowledgeMode = 'manual') {
  // Socket.IO reuses namespace socket objects across reconnects.
  const namespace = new LiveFeedSocket(acknowledgeMode);
  const managerEvents = new EventEmitter();
  const manager: Manager = partialDouble<Manager>({
    on: (event, listener) => { managerEvents.on(event, listener); return manager; },
    socket: () => namespace.socket,
  });
  const root = new LiveFeedSocket(acknowledgeMode, manager);
  return { root: root.socket, namespace, reconnect: () => managerEvents.emit('reconnect') };
}

/**
 * A root socket that refuses to connect, like a Homey that cannot be reached
 * but with no I/O. `connect()` fires `connect_error` a microtask later, so the
 * feed's `start()` gives up without running the handshake. A socket that never
 * settled would instead hold `onInit` on a 15 s handshake timeout nothing
 * advances.
 */
function refusingSocket(): Socket {
  const events = new EventEmitter();
  const socket: Socket = partialDouble<Socket>({
    connected: false,
    io: partialDouble<Manager>({
      on: () => socket.io,
      socket: () => refusingSocket(),
    }),
    on: (event, listener) => { events.on(event, listener); return socket; },
    once: (event, listener) => { events.once(event, listener); return socket; },
    off: (event, listener) => {
      if (event === undefined) events.removeAllListeners();
      else if (listener) events.off(event, listener);
      else events.removeAllListeners(event);
      return socket;
    },
    removeAllListeners: () => { events.removeAllListeners(); return socket; },
    connect: () => {
      queueMicrotask(() => events.emit('connect_error', new Error('live feed disabled in tests')));
      return socket;
    },
    disconnect: () => socket,
    emit: () => socket,
  });
  return socket;
}

let accepting = false;
const namespaces = new Set<LiveFeedSocket>();

/** The `io` export of the global `socket.io-client` mock (`test/setup.ts`). */
export function liveFeedIo(): Socket {
  if (!accepting) return refusingSocket();
  const harness = createLiveFeedSocketHarness('auto');
  namespaces.add(harness.namespace);
  return harness.root;
}

/** Let the next device live feed connect. Call before `onInit()` / `transport.init()`. */
export function connectLiveFeed(): void {
  accepting = true;
}

/** Back to refusing every connection; `test/setup.ts` calls it after each test. */
export function resetLiveFeed(): void {
  accepting = false;
  namespaces.clear();
}

const deliver = (uri: string, eventName: string, data: unknown): boolean => {
  let delivered = false;
  for (const namespace of namespaces) {
    if (namespace.deliver(uri, eventName, data)) delivered = true;
  }
  return delivered;
};

/**
 * Drain the feed's subscription passes: the per-device subscriptions a
 * committed refresh asked for are acknowledged and their listeners attached.
 * Microtasks only, so a spec's fake clock never moves.
 */
export async function settleLiveFeed(): Promise<void> {
  let quietTurns = 0;
  for (let turn = 0; turn < 2000 && quietTurns < 20; turn += 1) {
    const before = subscriptionActivity;
    await Promise.resolve();
    quietTurns = subscriptionActivity === before ? quietTurns + 1 : 0;
  }
}

/**
 * A `capability` frame for one device, after the feed's pending subscriptions
 * settle; throws unless the feed subscribed to that device.
 */
export async function emitCapability(deviceId: string, capabilityId: string, value: unknown): Promise<void> {
  await settleLiveFeed();
  if (!deliver(deviceUri(deviceId), 'capability', { capabilityId, value })) {
    throw new Error(`No device live feed is subscribed to ${deviceUri(deviceId)}`);
  }
}
