import { toSimulationReasonLine } from '../../lib/plan/simulationReasonMood';
import { feedPhasePeaks } from '../../lib/power/phaseFeeds';
import { mainFusePhaseTargetKw } from '../../packages/shared-domain/src/settings/mainFuse';

describe('phase wording and peaks', () => {
  it('reads as hypothetical in simulation', () => {
    expect(toSimulationReasonLine('Waiting for room on L1', true)).toBe('Would be waiting for room on L1 (simulation)');
  });

  it('lists loads and a charging battery, never solar or a discharging battery', () => {
    const observe = vi.fn();
    const device = (name: string, measuredPowerKw: number, deviceClass: string, isBatteryOrSolar: boolean) => ({
      name, measuredPowerKw, deviceClass, isBatteryOrSolar, managed: true,
    });
    feedPhasePeaks({ phasePeaks: { observe } } as never, [
      device('Inverter', 5, 'solarpanel', true),
      device('Heater', 2, 'heater', false),
      device('Charging', 1, 'battery', true),
      device('Discharging', 0, 'battery', true),
    ] as never, { kind: 'on', phases: [] }, 1);
    expect(observe).toHaveBeenCalledWith(1, [], ['Heater', 'Charging']);
  });

  it('holds a phase to the same target the hint states', () => {
    expect(mainFusePhaseTargetKw(25, true)).toBeCloseTo(5.4625);
    expect(mainFusePhaseTargetKw(25, false)).toBeCloseTo(5.175);
  });
});
