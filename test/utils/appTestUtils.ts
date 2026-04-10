// Shared test utilities for app instance cleanup
// Use explicit .ts extension to avoid resolving app.json instead of app.ts.
// Static import goes through Vitest's esbuild transform, which handles `export =`.
import MyApp from '../../app.ts';

let appInstances: any[] = [];

type CreateAppOptions = {
  preserveStartupRestoreStabilization?: boolean;
};

/**
 * Create an app instance and track it for cleanup.
 * Call cleanupApps() in afterEach to properly stop all intervals.
 */
export function createApp(options: CreateAppOptions = {}): any {
  const app = new MyApp();
  if (!options.preserveStartupRestoreStabilization) {
    const originalInitPlanEngine = app.initPlanEngine.bind(app);
    app.initPlanEngine = (...args: unknown[]) => {
      const result = originalInitPlanEngine(...args);
      app.planEngine?.clearStartupRestoreStabilization?.();
      return result;
    };
  }
  appInstances.push(app);
  return app;
}

/**
 * Clean up all tracked app instances by calling onUninit().
 * Should be called in afterEach().
 */
export async function cleanupApps(): Promise<void> {
  for (const app of appInstances) {
    if (app && typeof app.onUninit === 'function') {
      try {
        await app.onUninit();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
  appInstances = [];
}
