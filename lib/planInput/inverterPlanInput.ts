import type { HomeMembershipPort } from '../home/membership';
import { MAIN_HOME_ID } from '../utils/settingsKeys';
import type { DeviceConfigurationRead } from '../ports/deviceConfigurationRead';
import type { ProjectedObservedDeviceState } from '../../packages/contracts/src/types';
import { isInverterCurtailmentEnabled } from '../../packages/shared-domain/src/settings/inverterCurtailment';
import type { InverterCurtailmentDevices } from '../../packages/shared-domain/src/settings/inverterCurtailment';
import type { InverterPlanInput, InverterExecutionRead } from '../ports/inverterControl';
import { inverterBindingsMatch } from '../planContract/inverterDecision';

/** The owner reads joined by this projection; no SDK access or retained state. */
export type InverterPlanInputSource = {
  configurations(): readonly DeviceConfigurationRead[];
  observed(deviceId: string): ProjectedObservedDeviceState | undefined;
  selected(): InverterCurtailmentDevices;
  membership(): HomeMembershipPort;
  simulation(): boolean;
  execution: InverterExecutionRead;
};

export function readInverterPlanInputs(source: InverterPlanInputSource): InverterPlanInput[] {
  const selected = source.selected();
  const simulation = source.simulation();
  const membership = source.membership();
  const configurations = source.configurations();
  const inputs = configurations.flatMap((configuration): InverterPlanInput[] => {
    if (!source.execution.ready(configuration.id)) return [];
    const ownership = source.execution.ownership(configuration.id);
    const surface = configuration.inverterControl;
    const state = source.observed(configuration.id);
    if (!surface || surface.authority === 'release_only' || !state?.inverterObservation || state.available === false
      || (ownership.kind === 'held' && !inverterBindingsMatch(ownership.claim.restoration.binding, surface))) {
      return ownership.kind === 'held' ? [{ kind: 'hand_back', deviceId: configuration.id }] : [];
    }
    const inMainHome = membership.filterDevicesForHome([{ id: configuration.id }], MAIN_HOME_ID).length === 1;
    return [{
      kind: 'controllable', deviceId: configuration.id, surface, observation: state.inverterObservation,
      enabled: isInverterCurtailmentEnabled(selected, configuration.id) && inMainHome && !simulation,
      notBeforeMs: source.execution.notBeforeMs(configuration.id),
      ownership,
    }];
  });
  const heldIds = source.execution.heldDeviceIds();
  const representedIds = new Set(inputs.map((input) => input.deviceId));
  // An absent device does not erase its durable authority. Keep the release
  // pending so a silent-meter pass can converge when the device returns.
  return [...inputs, ...heldIds.filter((id) => !representedIds.has(id))
    .map((deviceId): InverterPlanInput => ({ kind: 'hand_back', deviceId }))];
}
