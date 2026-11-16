import { BackgroundTasksController } from '../backgroundTasksController';
import { TeardownRegistry } from '../../lib/utils/teardownRegistry';
import type { AppContext } from '../../lib/app/appContext';
import { AppMemoryUsageSampler } from '../../lib/diagnostics/appMemoryFootprint';

/**
 * The background tasks, and the store their stop callbacks live in.
 *
 * Both are returned so `app.ts` holds them: the registry is the composition
 * root's, not the controller's. Handing the controller a registry nobody else
 * can reach would put the wiring layer's state one property deep rather than
 * giving it an owner — the letter of the no-state rule with none of its point
 * (`setup/AGENTS.md` § "No state").
 */
export type BackgroundTasks = {
  controller: BackgroundTasksController;
  teardown: TeardownRegistry;
  // One reader of Homey's view of the app's memory, shared by the warning
  // listener and the support report so both state the same last reading.
  appMemory: AppMemoryUsageSampler;
};

export const createBackgroundTasks = (ctx: AppContext): BackgroundTasks => {
  const teardown = new TeardownRegistry();
  const appMemory = new AppMemoryUsageSampler(ctx.homey);
  return {
    controller: new BackgroundTasksController(ctx, teardown, appMemory),
    teardown,
    appMemory,
  };
};
