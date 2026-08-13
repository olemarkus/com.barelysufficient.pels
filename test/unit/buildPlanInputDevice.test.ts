import type {
  BinaryControlDiscriminantProbe,
  PlanInputDevice,
} from '../../lib/plan/planTypes';
import { buildPlanInputDevice } from '../helpers/buildPlanInputDevice';

describe('buildPlanInputDevice', () => {
  it('applies the documented defaults when only id is provided', () => {
    const device = buildPlanInputDevice({ id: 'dev-1' });

    expect(device).toEqual({
      id: 'dev-1',
      name: 'dev-1',
      targets: [],
      binaryControl: { on: true },
      // Required base field — resolved the way the producer resolves it, never
      // left undefined for a consumer to read as "not commandable".
      commandableNow: true,
      // Likewise required: a plan device always carries a resolved draw. This
      // fixture declares no power at all, and the producer answers 0 for a device
      // nobody described — it no longer invents a generic 1 kW.
      currentDrawKw: 0,
      // The draw-when-running twin, also required. Unlike `currentDrawKw` this
      // one DOES end on a fallback: "draws nothing when running" is not an answer,
      // so the ladder resolves the 1 kW default rather than absence.
      expectedPowerKw: 1,
      // Which rung produced that number — required alongside it, so absence is
      // not a state any consumer can observe. A fixture nobody described lands
      // on the same last rung the 1 kW above came from.
      expectedPowerSource: 'default',
    });
  });

  it('lets overrides win over the defaults', () => {
    const overrides: Partial<PlanInputDevice> & { id: string } & BinaryControlDiscriminantProbe = {
      id: 'dev-2',
      name: 'Living room heater',
      binaryControl: { on: false },
    };
    const device = buildPlanInputDevice(overrides);

    expect(device.id).toBe('dev-2');
    expect(device.name).toBe('Living room heater');
    expect((device as PlanInputDevice & BinaryControlDiscriminantProbe).binaryControl?.on).toBe(false);
    expect(device.targets).toEqual([]);
  });

  it('passes through optional fields unchanged and leaves unspecified ones undefined', () => {
    const device = buildPlanInputDevice({
      id: 'dev-3',
      deviceClass: 'evcharger',
      currentOn: true,
      priority: 4,
      expectedPowerKw: 7.2,
      objectiveKind: 'ev_soc',
    });

    expect(device.deviceClass).toBe('evcharger');
    expect((device as PlanInputDevice & { currentOn: boolean }).currentOn).toBe(true);
    expect(device.priority).toBe(4);
    expect(device.expectedPowerKw).toBe(7.2);
    expect(device.objectiveKind).toBe('ev_soc');
  });

  it('replaces the default targets array when an override is supplied', () => {
    const targets: PlanInputDevice['targets'] = [
      { id: 'target_temperature', unit: 'C', value: 65 },
    ];

    const device = buildPlanInputDevice({ id: 'dev-4', targets });

    expect(device.targets).toBe(targets);
  });
});
