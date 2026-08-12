export type TargetCommandOwner = 'lifecycle' | 'ordinary';

export type TargetCommandClaim = {
  acquire: (
    deviceId: string,
    capabilityId: string,
    owner: TargetCommandOwner,
    desired: number,
    onRelease?: (released: TargetCommandClaimState) => void,
  ) => boolean;
  ownerOf: (deviceId: string, capabilityId: string) => TargetCommandOwner | undefined;
  release: (
    deviceId: string,
    capabilityId: string,
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
  const keyFor = (deviceId: string, capabilityId: string): string => `${deviceId}\u0000${capabilityId}`;
  return {
    acquire: (deviceId, capabilityId, owner, desired, onRelease) => {
      const key = keyFor(deviceId, capabilityId);
      const current = owners.get(key);
      if (current) {
        if (current.owner !== owner && onRelease) waiters.set(key, onRelease);
        return false;
      }
      owners.set(key, { owner, desired });
      return true;
    },
    ownerOf: (deviceId, capabilityId) => owners.get(keyFor(deviceId, capabilityId))?.owner,
    release: (deviceId, capabilityId, owner, desired, accepted) => {
      const key = keyFor(deviceId, capabilityId);
      const current = owners.get(key);
      if (current?.owner !== owner || !Object.is(current.desired, desired)) return;
      owners.delete(key);
      const waiter = waiters.get(key);
      waiters.delete(key);
      waiter?.({ ...current, accepted });
    },
  };
};
