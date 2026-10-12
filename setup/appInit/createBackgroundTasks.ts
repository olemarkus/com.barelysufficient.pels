import { BackgroundTasksController } from '../backgroundTasksController';
import { TeardownRegistry } from '../../lib/utils/teardownRegistry';
import type { AppContext } from '../../lib/app/appContext';

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
};

export const createBackgroundTasks = (ctx: AppContext): BackgroundTasks => {
  const teardown = new TeardownRegistry();
  return {
    controller: new BackgroundTasksController(ctx, teardown),
    teardown,
  };
};
