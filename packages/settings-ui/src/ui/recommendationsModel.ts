import type {
  SettingsUiRecommendationCar,
  SettingsUiRecommendationCarsRead,
} from '../../../contracts/src/settingsUiApi.ts';
import type { EvCarAssociations } from '../../../contracts/src/types.ts';
import { supportsNativeWiringActivation, type SettingsUiDeviceDetailItem } from './deviceUtils.ts';

export type RecommendationDismissals = Record<string, number>;

export type RecommendationTarget =
  | { kind: 'device'; deviceId: string }
  | { kind: 'devices' }
  // A settings panel or top-level tab, by its `data-panel` / `data-tab` id.
  | { kind: 'panel'; panelId: string };

export type SetupRecommendation = {
  id: string;
  version: number;
  // `recommendation`: something about this home's setup PELS would change.
  // `optional`: a feature that applies here and is not in use. Never urged —
  // dismissing one is the owner saying it is not for them.
  category: 'recommendation' | 'optional';
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

export const parseRecommendationCarsRead = (value: unknown): SettingsUiRecommendationCarsRead => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { state: 'unavailable' };
  const read = value as { state?: unknown; cars?: unknown };
  if (read.state === 'unavailable') return { state: 'unavailable' };
  if (read.state !== 'resolved' || !Array.isArray(read.cars)) return { state: 'unavailable' };
  if (!read.cars.every((car) => (
    typeof car === 'object'
    && car !== null
    && typeof (car as { id?: unknown }).id === 'string'
    && typeof (car as { name?: unknown }).name === 'string'
  ))) return { state: 'unavailable' };
  return { state: 'resolved', cars: read.cars as SettingsUiRecommendationCar[] };
};

export const resolveNativeControlRecommendations = (
  devices: readonly SettingsUiDeviceDetailItem[],
  nativeWiringEnabledByDeviceId: Readonly<Record<string, boolean>>,
): SetupRecommendation[] => (
  devices.flatMap((device) => {
    const conflict = device.flowConflict;
    const nativeControlEnabled = nativeWiringEnabledByDeviceId[device.id] === true
      || device.controlAdapter?.activationEnabled === true;
    const hasConflict = conflict !== undefined && conflict.conflictingCapabilities.length > 0;
    if (nativeControlEnabled && !hasConflict) return [];
    if (!hasConflict && !supportsNativeWiringActivation(device)) return [];
    if (nativeControlEnabled) {
      const flowReference = conflict?.flowName
        ? `the Flow “${conflict.flowName}”`
        : 'the conflicting Flow';
      return [{
        id: recommendationId('flow-conflict', device.id),
        version: RECOMMENDATION_VERSION,
        category: 'recommendation',
        title: `Remove conflicting Flow control for ${device.name}`,
        body: `Built-in device control is on, but ${flowReference} can still change the same setting. `
          + 'Disable the Flow, or delete its device-control action, so it cannot override PELS.',
        actionLabel: 'Review conflict',
        target: { kind: 'device', deviceId: device.id },
      }];
    }
    const flowReference = hasConflict && conflict.flowName
      ? `To switch, disable the Flow “${conflict.flowName}” or delete its device-control action, `
        + 'then turn on Built-in device control on the device page.'
      : 'To switch, disable each conflicting Flow or delete its device-control action, '
        + 'then turn on Built-in device control on the device page.';
    const body = hasConflict
      ? `Your current Flow keeps working. PELS can also control this device directly. ${flowReference}`
      : 'PELS can control this device directly. If you use a Flow to control the same setting, '
        + 'turn off only that action before enabling Built-in device control on the device page.';
    return [{
      id: recommendationId('built-in-control', device.id),
      version: RECOMMENDATION_VERSION,
      category: 'recommendation',
      title: `Use built-in device control for ${device.name}`,
      body,
      actionLabel: 'Review device',
      target: { kind: 'device', deviceId: device.id },
    }];
  })
);

export const resolveCarAssociationRecommendations = (
  devices: readonly SettingsUiDeviceDetailItem[],
  cars: readonly SettingsUiRecommendationCar[],
  associations: EvCarAssociations,
): SetupRecommendation[] => {
  const chargers = devices.filter((device) => device.deviceClass === 'evcharger');
  if (chargers.length === 0) return [];
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
      title: `Choose a charger for ${car.name}`,
      body: 'Choose the charger this car uses so PELS can read its battery level while it charges.',
      actionLabel: 'Choose charger',
      target,
    }]
  ));
};

export const resolveSetupRecommendations = (
  devices: readonly SettingsUiDeviceDetailItem[],
  cars: readonly SettingsUiRecommendationCar[],
  associations: EvCarAssociations,
  nativeWiringEnabledByDeviceId: Readonly<Record<string, boolean>>,
): SetupRecommendation[] => (
  [
    ...resolveNativeControlRecommendations(devices, nativeWiringEnabledByDeviceId),
    ...resolveCarAssociationRecommendations(devices, cars, associations),
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
