import type {
  SmartTaskCandidateDevice, SmartTaskCandidateGoal,
} from '../../contracts/src/smartTaskEdit';

/** Resolve a saved target independently of the candidate's current picker default. */
export const resolveSmartTaskCandidateGoal = (
  device: SmartTaskCandidateDevice,
  kind: SmartTaskCandidateGoal['kind'],
): SmartTaskCandidateGoal | undefined => (
  device.kind === kind ? device : device.otherGoals.find((goal) => goal.kind === kind)
);
