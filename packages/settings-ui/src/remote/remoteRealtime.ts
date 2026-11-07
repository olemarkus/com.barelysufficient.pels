import { PELS_APP_ID, type RemoteConnection } from './remoteConnection.ts';

// The slice of a socket.io client this module drives. Homey's Web API accepts
// the v4 client, locally and through the cloud host, as the runtime's live
// feed does.
// Methods, not function properties: the client types each listener by event,
// and only method parameters compare both ways.
export type RealtimeSocket = {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  open(): unknown;
  close(): unknown;
  io: { socket(namespace: string): RealtimeSocket };
};

export type RealtimeStatus = 'connecting' | 'live' | 'offline';

type HandshakeResult = { namespace?: unknown };

const APP_URI = `homey:app:${PELS_APP_ID}`;

// Homey's realtime protocol, as `homey-api` speaks it: on every (re)connect of
// the root socket, `handshakeClient` with the API key returns a session
// namespace; on that namespace, `subscribe` to the app's URI and its events
// arrive as `(event, data)` on that URI. A reconnect can hand out a new
// namespace, so each connect redoes the handshake and drops the old namespace.
// Returns a close, for when the page moves to another address.
export const connectRemoteRealtime = (
  connection: RemoteConnection,
  createSocket: (baseUrl: string) => RealtimeSocket,
  onEvent: (event: string, data: unknown) => void,
  onStatus: (status: RealtimeStatus) => void,
): (() => void) => {
  const root = createSocket(connection.baseUrl);
  let namespaceSocket: RealtimeSocket | null = null;

  // The socket.io manager caches namespace sockets, so a reconnect that hands
  // back the same namespace reuses this object: clear its listeners too.
  const dropNamespace = () => {
    namespaceSocket?.off(APP_URI);
    namespaceSocket?.off('connect');
    namespaceSocket?.close();
    namespaceSocket = null;
  };

  const subscribe = (namespace: string) => {
    dropNamespace();
    const socket = root.io.socket(namespace);
    namespaceSocket = socket;
    socket.on(APP_URI, (event: string, data: unknown) => onEvent(event, data));
    socket.on('connect', () => {
      socket.emit('subscribe', APP_URI, (error: unknown) => onStatus(error ? 'offline' : 'live'));
    });
    socket.open();
  };

  root.on('connect', () => {
    onStatus('connecting');
    root.emit(
      'handshakeClient',
      { token: connection.token, homeyId: connection.homeyId },
      (error: unknown, result: HandshakeResult | undefined) => {
        if (error || typeof result?.namespace !== 'string') {
          onStatus('offline');
          return;
        }
        subscribe(result.namespace);
      },
    );
  });
  root.on('disconnect', () => onStatus('offline'));
  root.open();
  return () => {
    dropNamespace();
    root.off('connect');
    root.off('disconnect');
    root.close();
    onStatus('offline');
  };
};
