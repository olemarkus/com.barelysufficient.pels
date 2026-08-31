/**
 * Type-only view of the browser window inside `page.evaluate` closures: the
 * Playwright fixture (`fixtures/homey.stub.js`) installs `Homey` and reads
 * `__PELS_HOMEY_STUB__` before boot. Types erase before serialization, so this
 * import never reaches the browser — it only replaces the old `window as any`
 * with members a rename will break loudly.
 */
export type StubWindow = Window & {
  Homey: {
    get: (key: string, cb: (error: Error | null, value?: unknown) => void) => void;
    __stub: {
      setSetting: (key: string, value: unknown) => void;
      emitSettingsSet: (key: string) => void;
    };
  };
  __PELS_HOMEY_STUB__: {
    settings?: Record<string, unknown>;
    apiHandlers?: Record<string, (...args: unknown[]) => unknown>;
    overviewRedesignEnabled?: boolean;
  };
};
