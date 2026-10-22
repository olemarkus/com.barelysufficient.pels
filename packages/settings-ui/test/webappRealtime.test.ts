import { connectRemoteRealtime, type RealtimeSocket } from '../src/remote/remoteRealtime.ts';

type Listener = (...args: unknown[]) => void;

// A socket.io v2 stand-in: records emits, lets the test fire events, and
// caches namespace sockets per name as the real manager does.
const createFakeSocket = (namespaces: Map<string, FakeSocket>): FakeSocket => {
  const listeners = new Map<string, Listener[]>();
  const socket: FakeSocket = {
    emitted: [],
    closed: false,
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener as Listener]);
      return socket;
    },
    off: (event) => {
      listeners.delete(event);
      return socket;
    },
    emit: (event, ...args) => {
      socket.emitted.push([event, ...args]);
      return socket;
    },
    open: () => socket,
    close: () => {
      socket.closed = true;
      return socket;
    },
    fire: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    io: {
      socket: (namespace) => {
        const existing = namespaces.get(namespace);
        if (existing) return existing;
        const created = createFakeSocket(namespaces);
        namespaces.set(namespace, created);
        return created;
      },
    },
  };
  return socket;
};

type FakeSocket = RealtimeSocket & {
  emitted: unknown[][];
  closed: boolean;
  fire: (event: string, ...args: unknown[]) => void;
  io: { socket: (namespace: string) => FakeSocket };
};

const lastAck = (socket: FakeSocket) => {
  const args = socket.emitted[socket.emitted.length - 1] ?? [];
  return args[args.length - 1] as Listener;
};

const start = () => {
  const namespaces = new Map<string, FakeSocket>();
  const root = createFakeSocket(namespaces);
  const onEvent = vi.fn();
  const onStatus = vi.fn();
  connectRemoteRealtime(
    { baseUrl: 'https://homey.example', homeyId: 'abc', token: 'u:s:t' },
    () => root,
    onEvent,
    onStatus,
  );
  return { root, namespaces, onEvent, onStatus };
};

const connectNamespace = (root: FakeSocket, namespaces: Map<string, FakeSocket>, namespace: string) => {
  root.fire('connect');
  lastAck(root)(null, { namespace });
  const socket = namespaces.get(namespace)!;
  socket.fire('connect');
  lastAck(socket)(null);
  return socket;
};

describe('remote realtime', () => {
  it('handshakes with the key, subscribes to the app, and passes its events on', () => {
    const { root, namespaces, onEvent, onStatus } = start();
    const socket = connectNamespace(root, namespaces, '/api-1');

    expect(root.emitted[0]?.slice(0, 2)).toEqual(['handshakeClient', { token: 'u:s:t', homeyId: 'abc' }]);
    expect(socket.emitted[0]?.slice(0, 2)).toEqual(['subscribe', 'homey:app:com.barelysufficient.pels']);
    expect(onStatus).toHaveBeenLastCalledWith('live');

    socket.fire('homey:app:com.barelysufficient.pels', 'plan_updated', { plan: 1 });
    expect(onEvent).toHaveBeenCalledWith('plan_updated', { plan: 1 });
  });

  it('handshakes again on reconnect and subscribes once, even on a reused namespace', () => {
    const { root, namespaces, onEvent } = start();
    const first = connectNamespace(root, namespaces, '/api-1');
    root.fire('disconnect', 'transport close');
    const second = connectNamespace(root, namespaces, '/api-1');

    expect(second).toBe(first);
    expect(second.emitted.filter(([event]) => event === 'subscribe')).toHaveLength(2);
    second.fire('homey:app:com.barelysufficient.pels', 'power_updated', {});
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('drops the old namespace when a reconnect hands out a new one', () => {
    const { root, namespaces, onEvent } = start();
    const first = connectNamespace(root, namespaces, '/api-1');
    connectNamespace(root, namespaces, '/api-2');

    expect(first.closed).toBe(true);
    first.fire('homey:app:com.barelysufficient.pels', 'plan_updated', {});
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('reports a refused handshake', () => {
    const { root, onStatus } = start();
    root.fire('connect');
    lastAck(root)({ message: 'Invalid Session' });
    expect(onStatus).toHaveBeenLastCalledWith('offline');
  });
});
