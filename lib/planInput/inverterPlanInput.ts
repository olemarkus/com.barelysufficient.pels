import type { HomeMembershipPort } from '../home/membership';
import { MAIN_HOME_ID } from '../utils/settingsKeys';
import type { DeviceConfigurationRead } from '../ports/deviceConfigurationRead';
import type { ProjectedObservedDeviceState } from '../../packages/contracts/src/types';
import { isInverterCurtailmentEnabled } from '../../packages/shared-domain/src/settings/inverterCurtailment';
import type { InverterCurtailmentDevices } from '../../packages/shared-domain/src/settings/inverterCurtailment';
import type { InverterPlanInput, InverterExecutionRead } from '../ports/inverterControl';

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
  return source.configurations().flatMap((configuration) => {
    const surface = configuration.inverterControl;
    if (!surface || !source.execution.ready(configuration.id)) return [];
    const state = source.observed(configuration.id);
    if (!state?.inverterObservation || state.available === false) return [];
    const inMainHome = membership.filterDevicesForHome([{ id: configuration.id }], MAIN_HOME_ID).length === 1;
    return [{
      deviceId: configuration.id, surface, observation: state.inverterObservation,
      enabled: isInverterCurtailmentEnabled(selected, configuration.id) && inMainHome && !simulation,
      notBeforeMs: source.execution.notBeforeMs(configuration.id),
      ownership: source.execution.ownership(configuration.id),
    }];
  });
}
