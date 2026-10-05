// Unit-lane setup, run before test/setup.ts in every spec file. The lane reuses
// workers across files instead of spawning one per file; clearing the module
// registry here still gives each file its own module instances, so module-level
// state (throttles, caches) and vi.mock() factories cannot leak between files.
vi.resetModules();
