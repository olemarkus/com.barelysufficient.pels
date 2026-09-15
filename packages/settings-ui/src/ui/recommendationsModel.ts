import type { SettingsUiRecommendationCarsRead } from '../../../contracts/src/settingsUiApi.ts';
import type { EvCarAssociations } from '../../../contracts/src/types.ts';
import type { SettingsUiDeviceDetailItem } from './deviceUtils.ts';

export type RecommendationDismissals = Record<string, number>;

export type SupportedCar = {
  id: string;
  name: string;
};

export type RecommendationTarget =
  | { kind: 'device'; deviceId: string }
  | { kind: 'devices' };

export type SetupRecommendation = {
  id: string;
  version: number;
  category: 'recommendation';
  title: string;
  body: string;
  actionLabel: string;
  target: RecommendationTarget;
};

export type RecommendationGroups = {
  active: SetupRecommendation[];
  dismissed: SetupRecommendation[];
};

const RECOMMENDATION_VERSION = 1;

const recommendationId = (kind: string, entityId: string): string => (
  `${kind}:${encodeURIComponent(entityId)}`
);

export const normalizeRecommendationDismissals = (value: unknown): RecommendationDismissals => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([id, version]) => (
    Number.isInteger(version) && (version as number) > 0 ? [[id, version as number]] : []
  )));
};

export const parseRecommendationCarsRead = (value: unknown): SettingsUiRecommendationCarsRead | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const read = value as { state?: unknown; cars?: unknown };
  if (read.state === 'unavailable') return { state: 'unavailable' };
  if (read.state !== 'resolved' || !Array.isArray(read.cars)) return null;
  if (!read.cars.every((car) => (
    typeof car === 'object'
    && car !== null
    && typeof (car as { id?: unknown }).id === 'string'
    && typeof (car as { name?: unknown }).name === 'string'
  ))) return null;
  return { state: 'resolved', cars: read.cars as SupportedCar[] };
};

const nativeControlRecommendations = (
  devices: readonly SettingsUiDeviceDetailItem[],
  nativeWiringEnabledByDeviceId: Readonly<Record<string, boolean>>,
): SetupRecommendation[] => (
  devices.flatMap((device) => {
    const conflict = device.flowConflict;
    const nativeControlEnabled = nativeWiringEnabledByDeviceId[device.id] === true
      || device.controlAdapter?.activationEnabled === true;
    if (!conflict || conflict.conflictingCapabilities.length === 0 || nativeControlEnabled) return [];
    const flowReference = conflict.flowName
      ? `Remove the Homey Flow “${conflict.flowName}”, then turn on Built-in device control on the device page.`
      : 'Remove the Homey Flow that controls it, then turn on Built-in device control on the device page.';
    return [{
      id: recommendationId('built-in-control', device.id),
      version: RECOMMENDATION_VERSION,
      category: 'recommendation',
      title: `Use built-in control for ${device.name}`,
      body: `PELS can control this device directly. ${flowReference}`,
      actionLabel: 'Review device',
      target: { kind: 'device', deviceId: device.id },
    }];
  })
);

const carAssociationRecommendations = (
  devices: readonly SettingsUiDeviceDetailItem[],
  cars: readonly SupportedCar[],
  associations: EvCarAssociations,
): SetupRecommendation[] => {
  const chargers = devices.filter((device) => device.deviceClass === 'evcharger');
  const chargerIds = new Set(chargers.map((charger) => charger.id));
  const associatedCarIds = new Set(
    Object.entries(associations).flatMap(([chargerId, association]) => (
      chargerIds.has(chargerId) ? association.carIds : []
    )),
  );
  const target: RecommendationTarget = chargers.length === 1
    ? { kind: 'device', deviceId: chargers[0]!.id }
    : { kind: 'devices' };
  return cars.flatMap((car) => (
    associatedCarIds.has(car.id) ? [] : [{
      id: recommendationId('charger-car', car.id),
      version: RECOMMENDATION_VERSION,
      category: 'recommendation' as const,
      title: `Connect ${car.name} to a charger`,
      body: chargers.length === 0
        ? 'Add a compatible charger to PELS, then choose this car on the charger page.'
        : 'Choose which charger this car may use so PELS can read its battery level and match charging sessions.',
      actionLabel: chargers.length === 0 ? 'Review devices' : 'Choose charger',
      target,
    }]
  ));
};

export const resolveSetupRecommendations = (
  devices: readonly SettingsUiDeviceDetailItem[],
  cars: readonly SupportedCar[],
  associations: EvCarAssociations,
  nativeWiringEnabledByDeviceId: Readonly<Record<string, boolean>>,
): SetupRecommendation[] => (
  [
    ...nativeControlRecommendations(devices, nativeWiringEnabledByDeviceId),
    ...carAssociationRecommendations(devices, cars, associations),
  ]
    .sort((left, right) => left.title.localeCompare(right.title))
);

export const groupSetupRecommendations = (
  recommendations: readonly SetupRecommendation[],
  dismissals: RecommendationDismissals,
): RecommendationGroups => recommendations.reduce<RecommendationGroups>((groups, recommendation) => {
  const target = dismissals[recommendation.id] === recommendation.version
    ? groups.dismissed
    : groups.active;
  target.push(recommendation);
  return groups;
}, { active: [], dismissed: [] });
