import { createPlanEngineState as createRealPlanEngineState, type PlanEngineState } from '../../lib/plan/planState';

/** No device is held off by the owner unless a spec says so: the one place a spec's state says that. */
const noDeviceExternallyHeld = (): boolean => false;

/**
 * A `PlanEngineState` for specs. The production factory requires the app clock
 * and the external-off-held read that the wiring supplies; a spec that does not
 * exercise either gets the fake clock's now and "never held", stated here once
 * rather than as a default hidden in the runtime constructor. A spec about the
 * hold passes its own read.
 */
export const createPlanEngineState = (
  nowTs = Date.now(),
  isExternalOffHeld: (deviceId: string) => boolean = noDeviceExternallyHeld,
): PlanEngineState => createRealPlanEngineState(nowTs, isExternalOffHeld);
