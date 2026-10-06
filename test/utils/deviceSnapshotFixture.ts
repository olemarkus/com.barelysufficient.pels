import type {
  DecoratedDeviceSnapshot,
  DeviceDescriptor,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import { isBatteryOrSolarClassKey } from '../../packages/shared-domain/src/batteryOrSolarRole';

type DescriptorIdentityKey = 'deviceClass' | 'deviceType' | 'isEvCharger' | 'binaryControllable' | 'isBatteryOrSolar';

/** The identity facts the parse producer resolves for every inventory device. */
export type DescriptorIdentity = Pick<DeviceDescriptor, DescriptorIdentityKey>;

/** A snapshot fixture that may leave the identity facts for the helper to resolve. */
type DescriptorIdentityFixture<T extends DescriptorIdentity> = Omit<T, DescriptorIdentityKey>
  & Partial<DescriptorIdentity>;

/**
 * Resolve the REQUIRED descriptor identity facts from what a snapshot
 * fixture already says, the way `managerParseDeviceFields` resolves them for a
 * real device. A fact the fixture states explicitly always wins.
 *
 * - `deviceType`: `'temperature'` iff the fixture carries the observed
 *   temperature facet; production demotes a facet-less claim to `'onoff'`.
 * - `binaryControllable`: the producer's own question, `binaryControl !== undefined`.
 * - `isEvCharger`: class `evcharger`, as the producer resolves it.
 * - `isBatteryOrSolar`: a battery or panel class key (`isBatteryOrSolarClassKey`).
 * - `deviceClass`: a fixture that names none gets `'socket'`, the supported class
 *   that implies no further fact: not a charger, not observe-only, and not one
 *   PELS reports starvation for. The class used to be optional, so such a fixture
 *   already planned as exactly that, and it keeps the meaning it was written with.
 */
export const resolveFixtureDescriptorIdentity = (fixture: Partial<DescriptorIdentity> & {
  temperature?: unknown;
  binaryControl?: unknown;
}): DescriptorIdentity => ({
  deviceClass: fixture.deviceClass ?? 'socket',
  deviceType: fixture.deviceType ?? (fixture.temperature !== undefined ? 'temperature' : 'onoff'),
  isEvCharger: fixture.isEvCharger ?? fixture.deviceClass === 'evcharger',
  isBatteryOrSolar: fixture.isBatteryOrSolar ?? isBatteryOrSolarClassKey(fixture.deviceClass ?? 'socket'),
  binaryControllable: fixture.binaryControllable ?? fixture.binaryControl !== undefined,
});

const withDescriptorIdentity = <T extends DescriptorIdentity>(
  fixture: DescriptorIdentityFixture<T>,
): T => ({
  ...fixture,
  ...resolveFixtureDescriptorIdentity(fixture as Partial<DescriptorIdentity> & {
    temperature?: unknown;
    binaryControl?: unknown;
  }),
}) as unknown as T;

/** A transport snapshot fixture with its identity facts resolved. */
export const transportSnapshotFixture = (
  fixture: DescriptorIdentityFixture<TransportDeviceSnapshot>,
): TransportDeviceSnapshot => withDescriptorIdentity<TransportDeviceSnapshot>(fixture);

/** {@link transportSnapshotFixture} over a list, for `setSnapshotForTests([...])`. */
export const transportSnapshotFixtures = (
  fixtures: DescriptorIdentityFixture<TransportDeviceSnapshot>[],
): TransportDeviceSnapshot[] => fixtures.map(transportSnapshotFixture);

/** A consumer-facing snapshot fixture with its identity facts resolved. */
const targetSnapshotFixture = (
  fixture: DescriptorIdentityFixture<TargetDeviceSnapshot>,
): TargetDeviceSnapshot => withDescriptorIdentity<TargetDeviceSnapshot>(fixture);

/** {@link targetSnapshotFixture} over a list. */
export const targetSnapshotFixtures = (
  fixtures: DescriptorIdentityFixture<TargetDeviceSnapshot>[],
): TargetDeviceSnapshot[] => fixtures.map(targetSnapshotFixture);

/** A decorated snapshot fixture with its identity facts resolved. */
export const decoratedSnapshotFixture = (
  fixture: DescriptorIdentityFixture<DecoratedDeviceSnapshot>,
): DecoratedDeviceSnapshot => withDescriptorIdentity<DecoratedDeviceSnapshot>(fixture);

/** A descriptor-plus-observation join fixture with its identity facts resolved. */
export const deviceSurfacesFixture = (
  fixture: DescriptorIdentityFixture<DeviceSurfaces>,
): DeviceSurfaces => withDescriptorIdentity<DeviceSurfaces>(fixture);

/** {@link deviceSurfacesFixture} over a list. */
export const deviceSurfacesFixtures = (
  fixtures: DescriptorIdentityFixture<DeviceSurfaces>[],
): DeviceSurfaces[] => fixtures.map(deviceSurfacesFixture);
