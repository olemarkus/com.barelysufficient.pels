import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

/** The ladder of a 3000 W heater stepped through `max_power_3000`. */
export const CONNECTED_300_STEPPED_LOAD_PROFILE: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 1750 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

/** The ladder of a 2000 W heater stepped through `max_power_2000` or `max_power`. */
export const CONNECTED_200_STEPPED_LOAD_PROFILE: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 700 },
    { id: 'medium', planningPowerW: 1300 },
    { id: 'max', planningPowerW: 2000 },
  ],
};
