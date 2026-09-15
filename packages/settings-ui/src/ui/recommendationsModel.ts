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

export type RecommendationContext = {
  devices: readonly SettingsUiDeviceDetailItem[];
  cars: readonly SupportedCar[];
  associations: EvCarAssociations;
  nativeWiringEnabledByDeviceId: Readonly<Record<string, boolean>>;
};

export type RecommendationGroups = {
  active: SetupRecommendation[];
  dismissed: SetupRecommendation[];
};

type HomeyDeviceEntry = {
  id?: unknown;
  name?: unknown;
  class?: unknown;
  hasCarAssociationSupport?: unknown;
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

export const parseSupportedCars = (value: unknown): SupportedCar[] | null => {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const device = entry as HomeyDeviceEntry;
    return typeof device.id === 'string'
      && typeof device.name === 'string'
      && device.class === 'car'
      && device.hasCarAssociationSupport === true
      ? [{ id: device.id, name: device.name }]
      : [];
  });
};

const nativeControlRecommendations = (context: RecommendationContext): SetupRecommendation[] => (
  context.devices.flatMap((device) => {
    const conflict = device.flowConflict;
    const nativeControlEnabled = context.nativeWiringEnabledByDeviceId[device.id] === true
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

const carAssociationRecommendations = (context: RecommendationContext): SetupRecommendation[] => {
  const chargers = context.devices.filter((device) => device.deviceClass === 'evcharger');
  const associatedCarIds = new Set(
    Object.values(context.associations).flatMap((association) => association.carIds),
  );
  const target: RecommendationTarget = chargers.length === 1
    ? { kind: 'device', deviceId: chargers[0]!.id }
    : { kind: 'devices' };
  return context.cars.flatMap((car) => (
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

export const resolveSetupRecommendations = (context: RecommendationContext): SetupRecommendation[] => (
  [...nativeControlRecommendations(context), ...carAssociationRecommendations(context)]
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
