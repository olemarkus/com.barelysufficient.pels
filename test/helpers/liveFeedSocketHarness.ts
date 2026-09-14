import { EventEmitter } from 'node:events';
import type { Manager, Socket } from 'socket.io-client';
import { partialDouble } from './partialDouble';

type Acknowledge = (error?: Error | null) => void;

/** Socket boundary with explicit control of device subscription acknowledgements. */
class LiveFeedSocket {
  readonly events = new EventEmitter();
  readonly subscriptions: string[] = [];
  readonly unsubscriptions: string[] = [];
  readonly socket: Socket;
  private readonly pending = new Map<string, Acknowledge[]>();

  constructor(manager?: Manager) {
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
      if (uri === 'homey:manager:devices') {
        queueMicrotask(() => ack(null));
      } else {
        this.subscriptions.push(uri);
        const pending = this.pending.get(uri) ?? [];
        pending.push((error) => ack(error));
        this.pending.set(uri, pending);
      }
    }
    if (event === 'unsubscribe' && typeof args[0] === 'string') this.unsubscriptions.push(args[0]);
  }

  acknowledge(deviceId: string, error?: Error): void {
    const callbacks = this.pending.get(`homey:device:${deviceId}`) ?? [];
    this.pending.delete(`homey:device:${deviceId}`);
    for (const callback of callbacks) callback(error);
  }

  takeAcknowledgement(deviceId: string): Acknowledge {
    const callback = this.pending.get(`homey:device:${deviceId}`)?.shift();
    if (!callback) throw new Error(`No pending subscription for ${deviceId}`);
    return callback;
  }

  capability(deviceId: string): void {
    this.events.emit(`homey:device:${deviceId}`, 'capability', { capabilityId: 'measure_power', value: 500 });
  }
}

export function createLiveFeedSocketHarness() {
  // Socket.IO reuses namespace socket objects across reconnects.
  const namespace = new LiveFeedSocket();
  const managerEvents = new EventEmitter();
  const manager: Manager = partialDouble<Manager>({
    on: (event, listener) => { managerEvents.on(event, listener); return manager; },
    socket: () => namespace.socket,
  });
  const root = new LiveFeedSocket(manager);
  return { root: root.socket, namespace, reconnect: () => managerEvents.emit('reconnect') };
}
