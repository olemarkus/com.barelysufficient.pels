import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

export type FlowSteppedLoadObservation = {
  deviceId: string;
  stepId: string;
  planningPowerW: number;
  observedAtMs: number;
};

/** The device owner admits Flow feedback before command convergence consumes it. */
export type FlowSteppedLoadAdmission =
  | { kind: 'accepted'; profile: SteppedLoadProfile; observation: FlowSteppedLoadObservation }
  | { kind: 'native_control' | 'invalid' | 'unchanged' };
