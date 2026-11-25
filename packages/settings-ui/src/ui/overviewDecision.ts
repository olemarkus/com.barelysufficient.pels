import type { DecisionCheck } from '../../../contracts/src/deviceStatus.ts';

export type OverviewDecisionItem = Omit<DecisionCheck, 'state'> & {
  state: DecisionCheck['state'] | 'not_met' | 'not_recorded' | 'at_risk' | 'held_back';
};
