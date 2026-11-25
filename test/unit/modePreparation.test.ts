import { describe, expect, it } from 'vitest';
import type { ModePreparationRead } from '../../lib/ports/modePreparation';
import { ModePreparationResolver } from '../../lib/thermostat/modePreparation';
import { resolveModePreparationLeadMs } from '../../lib/objectives/deferredObjectives/modePreparationLead';
import type {
  MeteredPlanInputKind, PlanInputDevice, TemperaturePlanInputKind,
} from '../../packages/planner-types/src/planInputDevice';
import { partialDouble } from '../helpers/partialDouble';
import { fixtureTemperatureSetpoints } from '../helpers/temperatureSetpointsFixture';

const HOUR_MS = 3_600_000;
const occurrence = { scheduleId: 'morning', mode: 'Home', at: '08:00', atMs: 8 * HOUR_MS };
type MeteredHeater = PlanInputDevice & TemperaturePlanInputKind & MeteredPlanInputKind;
const heater = (id: string, currentTemperature: number) => partialDouble<MeteredHeater>({
  id, name: id, deviceType: 'temperature', currentTemperature, currentTarget: 17,
  control: { managed: true, commandAuthority: true },
  currentDrawKw: 0, expectedPowerKw: 1, planningPowerKw: 1,
  targets: [{ id: 'target_temperature', value: 17, unit: '°C', min: 5, max: 35, step: 0.5 }],
});
const tracker = {
  objectiveProfiles: {
    slow: {
      updatedAtMs: 0, lastSample: { observedAtMs: 0, value: 17 },
      acceptedSamples: 8, rejectedSamples: 0,
      kwhPerUnit: { sampleCount: 8, mean: 0.75, m2: 0, min: 0.75, max: 0.75,
        confidence: 'high' as const, lastUpdatedMs: 0 },
    },
  },
};
const targets = {
  Night: { slow: 17, fast: 17, cooler: 24, lower: 21 },
  Home: { slow: 21, fast: 21, cooler: 20, lower: 17 },
};

const fixture = () => {
  let now = 0;
  let mode = 'Night';
  const tasks = new Set<string>();
  const failedTaskReads = new Set<string>();
  const overrides = new Set<string>();
  const external = new Set<string>();
  let leadScale = 1;
  let read: ModePreparationRead = occurrence;
  let previewDevices: PlanInputDevice[] = [];
  const preparation = new ModePreparationResolver({
    occurrence: () => read,
    readDevice: (id) => previewDevices.find((device) => device.id === id),
    readPreviewDevices: () => previewDevices,
    nowMs: () => now,
    currentMode: () => mode,
    modeTargets: () => targets,
    thermalDirection: (id) => id === 'cooler' ? 'cooling' : 'heating',
    canSetTemperature: (id) => !external.has(id),
    temporaryTemperatureC: (id) => overrides.has(id) ? 19 : null,
    smartTaskState: (id) => {
      if (failedTaskReads.has(id)) return 'unavailable';
      return tasks.has(id) ? 'open' : 'none';
    },
    leadMs: (device, fromC, targetC) => resolveModePreparationLeadMs(tracker, device, fromC, targetC) * leadScale,
  });
  const setpoints = fixtureTemperatureSetpoints({
    getOperatingMode: () => mode,
    getModeDeviceTargets: () => targets,
    getPreparedModeTargets: preparation.getPreparedModeTargets,
    getTemporaryTemperatureC: (id) => overrides.has(id) ? 19 : null,
  });
  return { preparation, setpoints, tasks, failedTaskReads, overrides, external,
    setPreviewDevices: (devices: PlanInputDevice[]) => { previewDevices = devices; },
    setOccurrence: (next: ModePreparationRead) => { read = next; },
    refineLead: (scale: number) => { leadScale = scale; },
    setRemaining: (hours: number) => { now = occurrence.atMs - hours * HOUR_MS; },
    switchMode: () => { mode = 'Home'; },
  };
};

describe('scheduled mode preparation', () => {
  it('starts each heater on its own lead and keeps the destination target as rooms warm', () => {
    const f = fixture();
    const devices = [heater('slow', 17), heater('fast', 17), heater('cooler', 24), heater('lower', 21)];
    f.setRemaining(4);
    expect(f.setpoints(devices).get('slow')?.keepC).toBe(17);
    f.setRemaining(3);
    expect(f.setpoints(devices).get('slow')).toMatchObject({
      keepC: 21, modePreparation: { mode: 'Home', at: '08:00' },
    });
    f.refineLead(0.5);
    f.setRemaining(0.5);
    f.setOccurrence('unavailable');
    const duringReadFailure = f.setpoints(devices);
    expect(duringReadFailure.get('slow')?.keepC).toBe(21);
    expect(duringReadFailure.get('fast')?.keepC).toBe(17);
    f.setOccurrence(occurrence);
    f.setRemaining(3);
    expect(f.setpoints([heater('slow', 20.9)]).get('slow')?.keepC).toBe(21);
    expect(f.setpoints(devices).get('fast')?.keepC).toBe(17);

    f.setRemaining(0);
    const readings = [heater('slow', 20.5), heater('fast', 20.4)];
    expect(f.preparation.result(readings, occurrence)).toBe('The device was ready.');
    expect(f.preparation.result(readings, { ...occurrence, scheduleId: 'other' })).toBe('');
    expect(f.setpoints(devices).get('fast')?.keepC).toBe(21);
    expect(f.setpoints(devices).get('cooler')?.keepC).toBe(24);
    expect(f.setpoints(devices).get('lower')?.keepC).toBe(21);
    expect(f.preparation.result(readings, occurrence)).toBe('1 of 2 devices were ready.');
    f.setOccurrence('unavailable');
    f.setRemaining(-2 / 60);
    expect(f.setpoints(devices).get('slow')?.keepC).toBe(17);
    f.setOccurrence(occurrence);
    f.switchMode();
    expect(f.setpoints(devices).get('slow')).toMatchObject({ keepC: 21 });
    expect(f.setpoints(devices).get('slow')?.modePreparation).toBeUndefined();
  });

  it('leaves an open task and a temperature override in charge of their devices', () => {
    const f = fixture();
    f.tasks.add('slow');
    f.overrides.add('fast');
    f.setRemaining(1);
    const devices = [heater('slow', 17), heater('fast', 17)];
    expect(f.setpoints(devices).get('slow')?.keepC).toBe(17);
    expect(f.setpoints(devices).get('fast')?.keepC).toBe(19);
    f.tasks.clear();
    expect(f.setpoints(devices).get('slow')?.keepC).toBe(21);
  });

  it('keeps the last accepted Smart task state for an already preparing heater', () => {
    const f = fixture();
    const devices = [heater('slow', 17), heater('fast', 17)];
    f.setPreviewDevices(devices);
    f.setRemaining(2.5);
    expect(f.setpoints(devices).get('slow')?.keepC).toBe(21);
    f.setRemaining(1);
    f.failedTaskReads.add('slow');
    f.failedTaskReads.add('fast');

    expect(f.setpoints(devices).get('slow')?.keepC).toBe(21);
    expect(f.setpoints(devices).get('fast')?.keepC).toBe(17);
    expect(f.preparation.readPreparedTemperatureC('slow')).toBe(21);
    expect(f.preparation.preview(occurrence).map(({ state }) => state)).toEqual(['preparing', 'unavailable']);

    f.failedTaskReads.delete('slow');
    f.tasks.add('slow');
    expect(f.preparation.preview(occurrence)[0]?.state).toBe('smart_task');
    f.failedTaskReads.add('slow');
    expect(f.setpoints(devices).get('slow')?.keepC).toBe(17);
    expect(f.preparation.readPreparedTemperatureC('slow')).toBeNull();

    f.failedTaskReads.delete('slow');
    f.tasks.delete('slow');
    expect(f.setpoints(devices).get('slow')?.keepC).toBe(21);
    f.failedTaskReads.add('slow');
    f.overrides.add('slow');
    expect(f.setpoints(devices).get('slow')?.keepC).toBe(19);
    expect(f.preparation.preview(occurrence)[0]?.state).toBe('override');
  });

  it('shows estimated starts and current precedence without starting preparation', () => {
    const f = fixture();
    const slow = heater('slow', 17);
    const fast = heater('fast', 17);
    const devices = [slow, fast, heater('cooler', 24), heater('lower', 21)];
    f.setPreviewDevices(devices);
    f.setRemaining(7);
    expect(f.preparation.preview(occurrence)).toEqual([
      { deviceId: 'slow', name: 'slow', fromC: 17, targetC: 21, state: 'estimated', startAtMs: 4.5 * HOUR_MS },
      { deviceId: 'fast', name: 'fast', fromC: 17, targetC: 21, state: 'estimated', startAtMs: 6 * HOUR_MS },
    ]);

    f.setRemaining(1);
    f.tasks.add('fast');
    expect(f.preparation.preview(occurrence).map(({ state }) => state)).toEqual(['waiting_to_start', 'smart_task']);
    expect(f.preparation.result(devices, occurrence)).toBe('');
    f.setpoints(devices);
    expect(f.preparation.preview(occurrence).map(({ state }) => state)).toEqual(['preparing', 'smart_task']);

    f.overrides.add('slow');
    expect(f.preparation.preview(occurrence).map(({ state }) => state)).toEqual(['override', 'smart_task']);
  });

  it('leaves externally controlled temperatures with their owner', () => {
    const f = fixture();
    f.external.add('slow');
    f.setRemaining(1);
    expect(f.setpoints([heater('slow', 17)]).get('slow')?.modePreparation).toBeUndefined();
  });
});
