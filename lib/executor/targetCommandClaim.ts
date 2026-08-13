export type TargetCommandOwner = 'lifecycle' | 'ordinary';

export type TargetCommandClaim = {
  acquire: (
    deviceId: string,
    target: 'temperature',
    owner: TargetCommandOwner,
    desired: number,
    onRelease?: (released: TargetCommandClaimState) => void,
  ) => boolean;
  ownerOf: (deviceId: string, target: 'temperature') => TargetCommandOwner | undefined;
  release: (
    deviceId: string,
    target: 'temperature',
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
  const keyFor = (deviceId: string, target: 'temperature'): string => `${deviceId}\u0000${target}`;
  return {
    acquire: (deviceId, target, owner, desired, onRelease) => {
      const key = keyFor(deviceId, target);
      const current = owners.get(key);
      if (current) {
        if (current.owner !== owner && onRelease) waiters.set(key, onRelease);
        return false;
      }
      owners.set(key, { owner, desired });
      return true;
    },
    ownerOf: (deviceId, target) => owners.get(keyFor(deviceId, target))?.owner,
    release: (deviceId, target, owner, desired, accepted) => {
      const key = keyFor(deviceId, target);
      const current = owners.get(key);
      if (current?.owner !== owner || !Object.is(current.desired, desired)) return;
      owners.delete(key);
      const waiter = waiters.get(key);
      waiters.delete(key);
      waiter?.({ ...current, accepted });
    },
  };
};
