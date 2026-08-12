import type { TargetCommandOwner } from './targetCommandClaim';

export type BinaryCommandClaim = {
  acquire: (
    deviceId: string,
    owner: TargetCommandOwner,
    desired: boolean,
    onRelease?: (released: BinaryCommandClaimState) => void,
  ) => boolean;
  ownerOf: (deviceId: string) => TargetCommandOwner | undefined;
  release: (deviceId: string, owner: TargetCommandOwner, desired: boolean, accepted: boolean) => void;
};

export type BinaryCommandClaimState = {
  owner: TargetCommandOwner;
  desired: boolean;
  accepted: boolean;
};

/** Synchronous, skip-only reservation shared by ordinary and lifecycle binary dispatch. */
export const createBinaryCommandClaim = (): BinaryCommandClaim => {
  const owners = new Map<string, { owner: TargetCommandOwner; desired: boolean }>();
  const waiters = new Map<string, (released: BinaryCommandClaimState) => void>();
  return {
    acquire: (deviceId, owner, desired, onRelease) => {
      const current = owners.get(deviceId);
      if (current) {
        if (current.owner !== owner && onRelease) waiters.set(deviceId, onRelease);
        return false;
      }
      owners.set(deviceId, { owner, desired });
      return true;
    },
    ownerOf: (deviceId) => owners.get(deviceId)?.owner,
    release: (deviceId, owner, desired, accepted) => {
      const current = owners.get(deviceId);
      if (current?.owner !== owner || current.desired !== desired) return;
      owners.delete(deviceId);
      const waiter = waiters.get(deviceId);
      waiters.delete(deviceId);
      waiter?.({ ...current, accepted });
    },
  };
};
