import type { DeviceDescriptor } from '../../../contracts/src/types.ts';
import { isObserveOnlyRoleClassKey } from '../../../shared-domain/src/observeOnlyRole.ts';

type DescriptorIdentityKey = 'deviceClass' | 'deviceType' | 'isEvCharger' | 'binaryControllable' | 'observeOnly';

/** The identity facts the parse producer resolves for every inventory device. */
type DescriptorIdentity = Pick<DeviceDescriptor, DescriptorIdentityKey>;

/** A snapshot fixture that may leave the identity facts for the helper to resolve. */
type DescriptorIdentityFixture<T extends DescriptorIdentity> = Omit<T, DescriptorIdentityKey>
  & Partial<DescriptorIdentity>;

/**
 * Resolve the REQUIRED descriptor identity facts from what a snapshot
 * fixture already says, so a fixture written when they were optional keeps the
 * meaning it was written with. A fact the fixture states explicitly always wins.
 * The settings UI tests keep their own copy rather than importing the runtime
 * test tree (`test/utils/deviceSnapshotFixture.ts`), and it differs from that
 * one where the settings UI read the absent field differently from the runtime:
 *
 * - `deviceType`: `'temperature'` iff the fixture lists a target capability.
 *   That is the settings UI's own fallback for a device that states no type
 *   (`supportsTemperatureDevice`), and the producer co-emits the list with the
 *   temperature facet (`managerParseDeviceFields`), so it is also the answer
 *   production would have given.
 * - `binaryControllable`: `false` unless stated. Every settings UI reader asks
 *   `binaryControllable === true`, so an absent field already read as `false`;
 *   deriving it from `binaryControl` would switch on surfaces (start policy,
 *   external-off row, temperature policy copy) the fixture never asked for.
 * - `isEvCharger`: class `evcharger`, as the producer resolves it.
 * - `observeOnly`: a battery or panel class key (`isObserveOnlyRoleClassKey`).
 * - `deviceClass`: a fixture that names none gets `'other'`, the key the device
 *   list already files a class-less device under (`groupDevicesByClass`), and a
 *   class that implies no further fact: not a charger, not observe-only, no
 *   class-specific shed floor. The class used to be optional, so such a fixture
 *   already read as exactly that, and it keeps the meaning it was written with.
 *   (The runtime helper picks `'socket'` instead: the runtime only admits
 *   supported classes, while the settings UI groups and labels by the raw key.)
 */
const resolveFixtureDescriptorIdentity = (fixture: Partial<DescriptorIdentity> & {
  targets?: readonly unknown[];
}): DescriptorIdentity => ({
  deviceClass: fixture.deviceClass ?? 'other',
  deviceType: fixture.deviceType ?? ((fixture.targets?.length ?? 0) > 0 ? 'temperature' : 'onoff'),
  isEvCharger: fixture.isEvCharger ?? fixture.deviceClass === 'evcharger',
  observeOnly: fixture.observeOnly ?? isObserveOnlyRoleClassKey(fixture.deviceClass ?? 'other'),
  binaryControllable: fixture.binaryControllable ?? false,
});

/** A snapshot fixture of type `T` with its identity facts resolved. */
export const withDescriptorIdentity = <T extends DescriptorIdentity>(
  fixture: DescriptorIdentityFixture<T>,
): T => ({
  ...fixture,
  ...resolveFixtureDescriptorIdentity(fixture as Partial<DescriptorIdentity> & {
    targets?: readonly unknown[];
  }),
}) as unknown as T;

/** {@link withDescriptorIdentity} over a list. */
export const withDescriptorIdentities = <T extends DescriptorIdentity>(
  fixtures: DescriptorIdentityFixture<T>[],
): T[] => fixtures.map((fixture) => withDescriptorIdentity<T>(fixture));
