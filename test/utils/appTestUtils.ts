// Shared test utilities for app instance cleanup

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let appInstances: any[] = [];

// eslint-disable-next-line @typescript-eslint/no-var-requires
const MyApp = require('../../app');

/**
 * Create an app instance and track it for cleanup.
 * Call cleanupApps() in afterEach to properly stop all intervals.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createApp(): any {
  const app = new MyApp();
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
