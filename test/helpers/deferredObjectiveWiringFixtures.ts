import type { ResolveObjectiveDeviceExclusion } from '../../lib/objectives/deferredObjectives/deviceExclusion';
import type { DeferredObjectiveStallClassificationReader } from '../../lib/objectives/deferredObjectives/diagnosticTypes';

// Live-wiring inputs every smart-task allocation takes, answered the way a
// single main home with no parked device answers them.

/** Every device is in the main planning lane and managed by PELS. */
export const noDeviceExclusion: ResolveObjectiveDeviceExclusion = () => null;

/** No device is parked at its target. */
export const noStallEvidence: DeferredObjectiveStallClassificationReader = () => undefined;
