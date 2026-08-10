import type {
  ExpectedPowerOverridesByDeviceId,
  ExpectedPowerOverridesRead,
} from '../lib/device/devicePowerPeak';

/**
 * Two manual figures this close together are the same figure. Guards the
 * change-gate on both writers (`AppFlowBacked.setExpectedOverride` and the
 * adoption below) so a re-persist of an unchanged record is not reported as a
 * change.
 */
export const EXPECTED_OVERRIDE_EQUALS_EPSILON_KW = 0.000001;

const isSameOverrideKw = (a: number | undefined, b: number): boolean => (
  typeof a === 'number' && Math.abs(a - b) <= EXPECTED_OVERRIDE_EQUALS_EPSILON_KW
);

/**
 * Which side is the newer instruction where both carry a figure for a device.
 *
 * - `held` — the run's own map. Boot adoption and the write fence, where the
 *   owner may already have typed a figure this run that has not reached settings
 *   yet; letting the record win there would undo what they just typed.
 * - `persisted` — the record. The settings-key reload, where the write that woke
 *   us IS the new instruction, so a device the record no longer carries has been
 *   cleared and has to leave the map with it.
 */
export type ExpectedOverrideAuthority = 'held' | 'persisted';

/**
 * Adopt the persisted manual expected-power figures into the live map,
 * answering whether the read RESOLVED.
 *
 * IN PLACE, deliberately: `DeviceTransport` holds this same object by reference
 * (`setup/appInit/wireDeviceTransport.ts`), so replacing it would leave the
 * transport resolving expected power against the record it was constructed with.
 *
 * An `unavailable` read leaves the map alone and answers `false`, which is what
 * keeps the caller's write fence shut — a transient external failure must never
 * destroy persisted state (`notes/persisted-settings-state.md`). A resolved
 * EMPTY record is the opposite kind of answer: it is what clearing the last
 * manual figure persists as, so under `persisted` authority it clears the map.
 *
 * `onOverrideChanged` fires per device whose figure ends up new or different,
 * after the map is current, mirroring `setExpectedOverride`'s own change-gate.
 * It is REQUIRED rather than optional: a caller with nothing to notify (the boot
 * adoption) says so with an explicit empty callback, so a caller that MEANT to
 * react and forgot is a compile error instead of a silent no-op.
 */
export const applyExpectedPowerOverrides = (params: {
  read: ExpectedPowerOverridesRead;
  target: ExpectedPowerOverridesByDeviceId;
  authority: ExpectedOverrideAuthority;
  onOverrideChanged: (deviceId: string, kw: number) => void;
}): boolean => {
  const {
    read, target, authority, onOverrideChanged,
  } = params;
  if (read.state === 'unavailable') return false;

  const next = authority === 'held'
    ? { ...read.overrides, ...target }
    : { ...read.overrides };
  // Gated on the merged result, not on the record: under `held` authority a
  // device the record also carries keeps the figure it already had, and an
  // unchanged figure is not a change to report.
  const changed = Object.entries(next).filter(
    ([deviceId, entry]) => !isSameOverrideKw(target[deviceId]?.kw, entry.kw),
  );
  /* eslint-disable functional/immutable-data --
   * The in-place replace is the point of this helper: the transport holds this
   * exact object, so producing a new record would leave it reading the old one.
   * Documented in the docblock above. */
  for (const deviceId of Object.keys(target)) delete target[deviceId];
  Object.assign(target, next);
  /* eslint-enable functional/immutable-data */
  for (const [deviceId, entry] of changed) onOverrideChanged(deviceId, entry.kw);
  return true;
};
