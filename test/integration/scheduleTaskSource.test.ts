import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeferredObjectivePlanPreviewCandidate } from '../../packages/contracts/src/deferredObjectivePlanPreview';
import {
  normalizeDeferredObjectiveSettingsEntry,
} from '../../packages/shared-domain/src/settings/deferredObjectiveSettings';
import { gateCandidateExtraPermissions } from '../../lib/objectives/deferredObjectives/limitGrantGate';
import {
  objectiveAbsenceIsTrustworthy,
  readObjectiveForDevice,
  writeObjectiveForDevice,
} from '../../lib/objectives/deferredObjectives/objectiveStore';
import { createSettingsUiSmartTask, updateSettingsUiSmartTask } from '../../setup/settingsUiSmartTaskApi';
import { pelsHostDouble } from '../helpers/pelsHostDouble';
import { MockSettings } from '../mocks/homey';

const NOW_MS = Date.UTC(2026, 0, 1, 4);
const DEVICE = 'water-heater';
const SOURCE = { id: 'morning-water', name: 'Morning hot water' };
const baseEntry = () => ({
  enabled: true, kind: 'temperature', enforcement: 'soft', targetTemperatureC: 65,
  deadlineAtMs: NOW_MS + 4 * 60 * 60 * 1000,
});
const request = () => ({
  deviceId: DEVICE, kind: 'temperature', target: 70, readyByLocalTime: '07:00',
  scheduleSource: { id: 'forged', name: 'Client supplied origin' },
});

function context() {
  const settings = new MockSettings();
  settings.set('capacity_limit_kw', 10);
  const save = vi.fn((deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate) => {
    const entry = normalizeDeferredObjectiveSettingsEntry({ ...candidate, enabled: true });
    if (!entry) throw new Error('Invalid test candidate');
    writeObjectiveForDevice(settings, deviceId, entry);
    return { ok: true as const };
  });
  return {
    settings,
    save,
    homey: {
      settings, clock: { getTimezone: () => 'Europe/Oslo' },
      app: pelsHostDouble({
        resolveSmartTaskHomeScope: () => 'main',
        createDeferredObjective: save,
        createNewDeferredObjective: save,
      }),
    } as never,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});
afterEach(() => vi.useRealTimers());

describe('scheduled Smart-task source', () => {
  it('reads the saved origin as a separate normalized object', () => {
    const { settings } = context();
    const source = { id: ` ${SOURCE.id} `, name: ` ${SOURCE.name} `, unexpected: 'discard' };
    settings.set(`deferred_objective.${DEVICE}`, { ...baseEntry(), scheduleSource: source });

    const task = readObjectiveForDevice(settings, DEVICE);
    expect(task?.scheduleSource).toEqual(SOURCE);
    expect(task?.scheduleSource).not.toBe(source);
    source.name = 'Mutated transport object';
    expect(task?.scheduleSource?.name).toBe(SOURCE.name);
  });

  it.each([undefined, null, '', [], {}, { id: '', name: 'Name' }, { id: 'id', name: ' ' },
    { id: 1, name: 'Name' }, { id: 'id', name: false }])('rejects malformed present source %j', (source) => {
    const { settings } = context();
    settings.set(`deferred_objective.${DEVICE}`, { ...baseEntry(), scheduleSource: source });

    expect(readObjectiveForDevice(settings, DEVICE)).toBeUndefined();
    // Existing malformed bytes are a refused read, not permission to create
    // another task over a run whose origin could not be resolved.
    expect(objectiveAbsenceIsTrustworthy(settings, DEVICE)).toBe(false);
  });

  it('keeps existing tasks without a schedule source valid', () => {
    const { settings } = context();
    settings.set(`deferred_objective.${DEVICE}`, baseEntry());

    expect(readObjectiveForDevice(settings, DEVICE)).toEqual(baseEntry());
  });

  it('keeps the trusted origin when an existing run is edited and ignores client origin', () => {
    const { homey, settings, save } = context();
    settings.set(`deferred_objective.${DEVICE}`, { ...baseEntry(), scheduleSource: SOURCE });

    expect(updateSettingsUiSmartTask({ homey, body: request() })).toEqual({ ok: true });
    expect(save).toHaveBeenCalled();
    expect(readObjectiveForDevice(settings, DEVICE)).toMatchObject({
      targetTemperatureC: 70, scheduleSource: SOURCE,
    });
  });

  it('does not attach a client-provided origin to a directly created task', () => {
    const { homey, settings } = context();

    expect(createSettingsUiSmartTask({ homey, body: request() })).toEqual({ ok: true });
    expect(readObjectiveForDevice(settings, DEVICE)?.scheduleSource).toBeUndefined();
  });

  it('retains the origin when the permission owner withholds a new limit grant', () => {
    const candidate: DeferredObjectivePlanPreviewCandidate = {
      kind: 'temperature', enforcement: 'soft', targetTemperatureC: 65, deadlineAtMs: NOW_MS + 1000,
      scheduleSource: SOURCE, rescue: { limitLowerPriorityDevices: 'always', exemptFromBudget: 'always' },
    };

    const gated = gateCandidateExtraPermissions(undefined, candidate, { entry: undefined, absenceTrustworthy: true });
    expect(gated.scheduleSource).toEqual(SOURCE);
    expect(gated.rescue).toEqual({ exemptFromBudget: 'always' });
  });
});
