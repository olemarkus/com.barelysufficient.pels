// socket.io-client v2 ships no types; this names the one call the standalone
// host makes. The returned socket is typed where it is used (`RealtimeSocket`).
declare module 'socket.io-client' {
  type ConnectOptions = {
    transports?: string[];
    autoConnect?: boolean;
  };
  const io: (url: string, options?: ConnectOptions) => import('./remoteRealtime.ts').RealtimeSocket;
  export default io;
}
