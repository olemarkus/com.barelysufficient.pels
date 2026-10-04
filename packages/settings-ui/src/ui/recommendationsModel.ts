import type {
  SettingsUiRecommendationCar,
  SettingsUiEvSocFlowReporter,
} from '../../../contracts/src/settingsUiApi.ts';
import type { EvCarAssociations } from '../../../contracts/src/types.ts';
import {
  resolveDeviceStartPolicy,
  type DeviceStartPolicy,
} from '../../../shared-domain/src/settings/deviceStartPolicy.ts';
import {
  requiresNativeWiringForActivation,
  supportsNativeWiringActivation,
  supportsPowerDevice,
  supportsTemperatureDevice,
  type SettingsUiDeviceDetailItem,
} from './deviceUtils.ts';

export type RecommendationDismissals = Record<string, number>;

export type RecommendationTarget =
  | { kind: 'device'; deviceId: string }
  // The device page with Setup open on "Only PELS starts this device".
  | { kind: 'device-start-policy'; deviceId: string }
  | { kind: 'flow-conflict-check'; deviceId: string }
  | { kind: 'ev-soc-flow-conflict-check'; deviceId: string }
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

const nativeControlRecommendationAction = (
  deviceId: string,
  hasConflict: boolean,
): Pick<SetupRecommendation, 'actionLabel' | 'target'> => {
  if (hasConflict) {
    return {
      actionLabel: 'Check again',
      target: { kind: 'flow-conflict-check', deviceId },
    };
  }
  return { actionLabel: 'Review device', target: { kind: 'device', deviceId } };
};

export const normalizeRecommendationDismissals = (value: unknown): RecommendationDismissals => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([id, version]) => (
    Number.isInteger(version) && (version as number) > 0 ? [[id, version as number]] : []
  )));
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
        actionLabel: 'Check again',
        target: { kind: 'flow-conflict-check', deviceId: device.id },
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
      ...nativeControlRecommendationAction(device.id, hasConflict),
    }];
  })
);

/**
 * Only a car PELS has already matched to one of this home's chargers is worth
 * choosing: selecting a car makes PELS ignore the charger's other battery
 * sources until a match, so recommending a car that has never matched would
 * steer a working Flow-reported level into no level at all.
 */
export const resolveCarAssociationRecommendations = (
  devices: readonly SettingsUiDeviceDetailItem[],
  cars: readonly SettingsUiRecommendationCar[],
  associations: EvCarAssociations,
): SetupRecommendation[] => {
  const chargersById = new Map(
    devices
      .filter((device) => device.isEvCharger)
      .map((device) => [device.id, device]),
  );
  if (chargersById.size === 0) return [];
  const associatedCarIds = new Set(
    Object.entries(associations).flatMap(([chargerId, association]) => (
      chargersById.has(chargerId) ? association.carIds : []
    )),
  );
  return cars.flatMap((car) => {
    if (associatedCarIds.has(car.id)) return [];
    if (car.matchHistory.state !== 'resolved') return [];
    // Newest first, so this is the charger the car was matched to most recently.
    const match = car.matchHistory.chargerMatches.find(({ chargerId }) => chargersById.has(chargerId));
    const charger = match ? chargersById.get(match.chargerId) : undefined;
    if (!charger) return [];
    return [{
      id: recommendationId('charger-car', car.id),
      version: RECOMMENDATION_VERSION,
      category: 'optional' as const,
      title: `Select ${car.name} on ${charger.name}`,
      body: `PELS has matched ${car.name} to ${charger.name}. Select the car in its Car section so `
        + 'PELS can read its battery level while it charges.',
      actionLabel: 'Open charger',
      target: { kind: 'device' as const, deviceId: charger.id },
    }];
  });
};

/**
 * Whether a car selected for this charger has been matched to it, now or in the
 * retained history. Until one has, the charger has no battery level, so the
 * Flow that reports one is the owner's only working source, not a leftover.
 * `unknown` while a selected car's history is unreadable.
 */
const resolveSelectedCarMatch = (
  charger: SettingsUiDeviceDetailItem,
  selectedCarIds: readonly string[],
  cars: readonly SettingsUiRecommendationCar[],
): 'matched' | 'unmatched' | 'unknown' => {
  if (charger.associatedCar && selectedCarIds.includes(charger.associatedCar.carId)) return 'matched';
  const selected = cars.filter((car) => selectedCarIds.includes(car.id));
  if (selected.some(({ matchHistory }) => (
    matchHistory.state === 'resolved'
    && matchHistory.chargerMatches.some(({ chargerId }) => chargerId === charger.id)
  ))) return 'matched';
  return selected.some(({ matchHistory }) => matchHistory.state === 'unavailable') ? 'unknown' : 'unmatched';
};

const selectedCarLabel = (
  selectedCarIds: readonly string[],
  cars: readonly SettingsUiRecommendationCar[],
): string => {
  const names = cars.filter((car) => selectedCarIds.includes(car.id)).map((car) => car.name);
  return names.length === 1 ? names[0]! : 'the selected cars';
};

const flowReference = (reporter: SettingsUiEvSocFlowReporter): string => (
  reporter.flowName
    ? `the “Report battery level for charger” action in the Flow “${reporter.flowName}”`
    : '“Report battery level for charger” actions in enabled Homey Flows'
);

export const resolveEvSocFlowConflictRecommendations = (
  devices: readonly SettingsUiDeviceDetailItem[],
  associations: EvCarAssociations,
  reporters: readonly SettingsUiEvSocFlowReporter[],
  cars: readonly SettingsUiRecommendationCar[],
): SetupRecommendation[] => {
  const chargersById = new Map(
    devices
      .filter((device) => device.isEvCharger)
      .map((device) => [device.id, device]),
  );
  return reporters.flatMap((reporter): SetupRecommendation[] => {
    const charger = chargersById.get(reporter.chargerDeviceId);
    const selectedCarIds = charger ? associations[charger.id]?.carIds ?? [] : [];
    if (!charger || selectedCarIds.length === 0) return [];
    const match = resolveSelectedCarMatch(charger, selectedCarIds, cars);
    // Neither "remove it" nor "you need it" is honest without the history.
    if (match === 'unknown') return [];
    if (match === 'unmatched') {
      return [{
        id: recommendationId('ev-soc-flow-unmatched', charger.id),
        version: RECOMMENDATION_VERSION,
        category: 'recommendation' as const,
        title: `${charger.name} has no battery level`,
        body: `A car is selected for this charger, so PELS ignores ${flowReference(reporter)}. `
          + `PELS has not matched ${selectedCarLabel(selectedCarIds, cars)} to this charger yet, so the `
          + 'charger has no battery level. Clear the car selection to use the Flow again, and select '
          + 'the car once it shows as matched.',
        actionLabel: 'Open charger',
        target: { kind: 'device' as const, deviceId: charger.id },
      }];
    }
    const body = reporter.flowName
      ? `With a car selected, PELS ignores the “Report battery level for charger” action in the Flow `
        + `“${reporter.flowName}”. Remove that action or disable the Flow if you no longer need it.`
      : 'With a car selected, PELS ignores “Report battery level for charger” actions in enabled Homey Flows. '
        + 'Remove those actions or disable those Flows if you no longer need them.';
    return [{
      id: recommendationId('ev-soc-flow-conflict', charger.id),
      version: RECOMMENDATION_VERSION,
      category: 'recommendation' as const,
      title: `Remove unused battery reporting for ${charger.name}`,
      body,
      actionLabel: 'Check again',
      target: { kind: 'ev-soc-flow-conflict-check' as const, deviceId: charger.id },
    }];
  });
};

export const resolveSmartTaskStartPolicyRecommendations = (
  devices: readonly SettingsUiDeviceDetailItem[],
  managedMap: Readonly<Record<string, boolean>>,
  controllableMap: Readonly<Record<string, boolean>>,
  startPolicyMap: Readonly<Record<string, DeviceStartPolicy>>,
  usedSmartTaskDeviceIds: ReadonlySet<string>,
): SetupRecommendation[] => devices.flatMap((device) => {
  if (!usedSmartTaskDeviceIds.has(device.id)
    || managedMap[device.id] !== true
    || device.binaryControllable !== true
    || !(supportsPowerDevice(device) || supportsTemperatureDevice(device))
    || requiresNativeWiringForActivation(device)
    || controllableMap[device.id] === true
    || resolveDeviceStartPolicy(startPolicyMap, device.id) === 'pels_only') return [];
  return [{
    id: recommendationId('smart-task-start-policy', device.id),
    version: RECOMMENDATION_VERSION,
    category: 'optional',
    title: `Keep ${device.name} within Smart tasks`,
    body: 'Turn on “Only PELS starts this device” to keep it within Smart tasks. '
      + 'PELS turns it off if it is turned on outside a Smart task. Without a Smart task, it stays off.',
    actionLabel: 'Review device',
    target: { kind: 'device-start-policy', deviceId: device.id },
  }];
});

export const resolveSetupRecommendations = (
  devices: readonly SettingsUiDeviceDetailItem[],
  cars: readonly SettingsUiRecommendationCar[],
  associations: EvCarAssociations,
  nativeWiringEnabledByDeviceId: Readonly<Record<string, boolean>>,
  evSocReporters: readonly SettingsUiEvSocFlowReporter[] = [],
): SetupRecommendation[] => (
  [
    ...[
      ...resolveNativeControlRecommendations(devices, nativeWiringEnabledByDeviceId),
      ...resolveEvSocFlowConflictRecommendations(devices, associations, evSocReporters, cars),
    ].sort((left, right) => left.title.localeCompare(right.title)),
    ...resolveCarAssociationRecommendations(devices, cars, associations)
      .sort((left, right) => left.title.localeCompare(right.title)),
  ]
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
