export type TargetCommandOwner = 'lifecycle' | 'ordinary';

export type TargetCommandClaim = {
  acquire: (
    deviceId: string,
    owner: TargetCommandOwner,
    desired: number,
    onRelease?: (released: TargetCommandClaimState) => void,
  ) => boolean;
  ownerOf: (deviceId: string) => TargetCommandOwner | undefined;
  release: (
    deviceId: string,
    owner: TargetCommandOwner,
    desired: number,
    accepted: boolean,
  ) => void;
};

export type TargetCommandClaimState = {
  owner: TargetCommandOwner;
  desired: number;
  accepted: boolean;
};

/**
 * Serializes target writes across every executor clock. The claim is recorded
 * synchronously before the actuator promise is awaited, closing the window in
 * which the plan and lifecycle clocks could both decide to issue the same
 * command before either lane had installed its durable pending entry.
 */
export const createTargetCommandClaim = (): TargetCommandClaim => {
  const owners = new Map<string, { owner: TargetCommandOwner; desired: number }>();
  const waiters = new Map<string, (released: TargetCommandClaimState) => void>();
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
      if (current?.owner !== owner || !Object.is(current.desired, desired)) return;
      owners.delete(deviceId);
      const waiter = waiters.get(deviceId);
      waiters.delete(deviceId);
      waiter?.({ ...current, accepted });
    },
  };
};
