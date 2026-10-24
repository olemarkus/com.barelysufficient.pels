export type TargetCommandOwner = 'lifecycle' | 'ordinary';

export type CommandClaim<T> = {
  acquire: (
    deviceId: string,
    owner: TargetCommandOwner,
    desired: T,
    onRelease?: (released: CommandClaimState<T>) => void,
  ) => boolean;
  ownerOf: (deviceId: string) => TargetCommandOwner | undefined;
  release: (
    deviceId: string,
    owner: TargetCommandOwner,
    desired: T,
    accepted: boolean,
  ) => void;
};

export type CommandClaimState<T> = {
  owner: TargetCommandOwner;
  desired: T;
  accepted: boolean;
};

/**
 * Serializes binary, target and step writes across every executor clock. The
 * claim is recorded synchronously before the actuator promise is awaited,
 * closing the window in which the plan and lifecycle clocks could both decide
 * to issue the same command before either lane had installed its durable
 * pending entry. The reservation is skip-only: a lane that finds the device
 * claimed does not issue its command, and a lane of the other owner may wait
 * for the release instead.
 *
 * `release` matches the desired value with `Object.is`, which is `===` for
 * booleans and strings.
 */
export const createCommandClaim = <T>(): CommandClaim<T> => {
  const owners = new Map<string, { owner: TargetCommandOwner; desired: T }>();
  const waiters = new Map<string, (released: CommandClaimState<T>) => void>();
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
