import type { TargetCommandOwner } from './targetCommandClaim';

export type SteppedCommandClaim = {
  acquire: (
    deviceId: string,
    owner: TargetCommandOwner,
    desiredStepId: string,
    onRelease?: (released: SteppedCommandClaimState) => void,
  ) => boolean;
  ownerOf: (deviceId: string) => TargetCommandOwner | undefined;
  release: (
    deviceId: string,
    owner: TargetCommandOwner,
    desiredStepId: string,
    accepted: boolean,
  ) => void;
};

export type SteppedCommandClaimState = {
  owner: TargetCommandOwner;
  desiredStepId: string;
  accepted: boolean;
};

/** Synchronous, skip-only reservation shared by ordinary and lifecycle step dispatch. */
export const createSteppedCommandClaim = (): SteppedCommandClaim => {
  const owners = new Map<string, { owner: TargetCommandOwner; desiredStepId: string }>();
  const waiters = new Map<string, (released: SteppedCommandClaimState) => void>();
  return {
    acquire: (deviceId, owner, desiredStepId, onRelease) => {
      const current = owners.get(deviceId);
      if (current) {
        if (current.owner !== owner && onRelease) waiters.set(deviceId, onRelease);
        return false;
      }
      owners.set(deviceId, { owner, desiredStepId });
      return true;
    },
    ownerOf: (deviceId) => owners.get(deviceId)?.owner,
    release: (deviceId, owner, desiredStepId, accepted) => {
      const current = owners.get(deviceId);
      if (current?.owner !== owner || current.desiredStepId !== desiredStepId) return;
      owners.delete(deviceId);
      const waiter = waiters.get(deviceId);
      waiters.delete(deviceId);
      waiter?.({ ...current, accepted });
    },
  };
};
