import {
  applyDeferredObjectiveChange,
  DeferredObjectiveActivePlanRecorder,
  DeferredObjectivePlanHistoryRecorder,
  type DeferredObjectiveSettingsEntry,
} from '../../lib/objectives/deferredObjectives';

const HOUR_MS = 60 * 60 * 1000;

const buildHistoryRecorder = (): DeferredObjectivePlanHistoryRecorder => (
  new DeferredObjectivePlanHistoryRecorder({
    load: () => null,
    save: () => true,
  })
);

const buildActiveRecorder = (): DeferredObjectiveActivePlanRecorder => (
  new DeferredObjectiveActivePlanRecorder({
    load: () => null,
    save: () => {},
  })
);

const tempEntry = (overrides: Partial<DeferredObjectiveSettingsEntry> = {}): DeferredObjectiveSettingsEntry => ({
  enabled: true,
  kind: 'temperature',
  enforcement: 'soft',
  targetTemperatureC: 65,
  deadlineAtMs: 6 * HOUR_MS,
  ...overrides,
} as DeferredObjectiveSettingsEntry);

const evEntry = (overrides: Partial<DeferredObjectiveSettingsEntry> = {}): DeferredObjectiveSettingsEntry => ({
  enabled: true,
  kind: 'ev_soc',
  enforcement: 'soft',
  targetPercent: 80,
  deadlineAtMs: 6 * HOUR_MS,
  ...overrides,
} as DeferredObjectiveSettingsEntry);

describe('applyDeferredObjectiveChange', () => {
  it('seeds a fresh pending active plan when no prior objective exists', () => {
    const planHistoryRecorder = buildHistoryRecorder();
    const activePlanRecorder = buildActiveRecorder();
    const finalizeSpy = vi.spyOn(planHistoryRecorder, 'finalizeForUserChange');
    const clearSpy = vi.spyOn(activePlanRecorder, 'clearForDevice');
    const markSpy = vi.spyOn(activePlanRecorder, 'markPending');

    applyDeferredObjectiveChange({
      deviceId: 'dev',
      deviceName: 'Boiler',
      prevEntry: undefined,
      nextEntry: tempEntry(),
      nowMs: 0,
      planHistoryRecorder,
      activePlanRecorder,
    });

    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(markSpy.mock.calls[0]![0]).toMatchObject({
      deviceId: 'dev',
      objectiveKind: 'temperature',
      targetTemperatureC: 65,
      deadlineAtMs: 6 * HOUR_MS,
    });
  });

  it('finalizes the prior run as `replaced` when the deadline changes', () => {
    const planHistoryRecorder = buildHistoryRecorder();
    const activePlanRecorder = buildActiveRecorder();
    const finalizeSpy = vi.spyOn(planHistoryRecorder, 'finalizeForUserChange');
    const clearSpy = vi.spyOn(activePlanRecorder, 'clearForDevice');
    const markSpy = vi.spyOn(activePlanRecorder, 'markPending');

    applyDeferredObjectiveChange({
      deviceId: 'dev',
      deviceName: 'Boiler',
      prevEntry: tempEntry({ deadlineAtMs: 4 * HOUR_MS }),
      nextEntry: tempEntry({ deadlineAtMs: 8 * HOUR_MS }),
      nowMs: HOUR_MS,
      planHistoryRecorder,
      activePlanRecorder,
    });

    expect(finalizeSpy).toHaveBeenCalledWith('dev', HOUR_MS, 'replaced');
    expect(clearSpy).not.toHaveBeenCalled();
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(markSpy.mock.calls[0]![0]!.deadlineAtMs).toBe(8 * HOUR_MS);
  });

  it('finalizes the prior run as `replaced` when only the target changes', () => {
    const planHistoryRecorder = buildHistoryRecorder();
    const activePlanRecorder = buildActiveRecorder();
    const finalizeSpy = vi.spyOn(planHistoryRecorder, 'finalizeForUserChange');
    const clearSpy = vi.spyOn(activePlanRecorder, 'clearForDevice');
    const markSpy = vi.spyOn(activePlanRecorder, 'markPending');

    applyDeferredObjectiveChange({
      deviceId: 'dev',
      deviceName: 'Boiler',
      prevEntry: tempEntry({ targetTemperatureC: 60 }),
      nextEntry: tempEntry({ targetTemperatureC: 70 }),
      nowMs: HOUR_MS,
      planHistoryRecorder,
      activePlanRecorder,
    });

    expect(finalizeSpy).toHaveBeenCalledWith('dev', HOUR_MS, 'replaced');
    expect(clearSpy).not.toHaveBeenCalled();
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(markSpy.mock.calls[0]![0]).toMatchObject({
      targetTemperatureC: 70,
      deadlineAtMs: 6 * HOUR_MS,
    });
  });

  it('does nothing when the objective signature is identical', () => {
    const planHistoryRecorder = buildHistoryRecorder();
    const activePlanRecorder = buildActiveRecorder();
    const finalizeSpy = vi.spyOn(planHistoryRecorder, 'finalizeForUserChange');
    const markSpy = vi.spyOn(activePlanRecorder, 'markPending');

    applyDeferredObjectiveChange({
      deviceId: 'dev',
      deviceName: 'Boiler',
      prevEntry: tempEntry(),
      nextEntry: tempEntry(),
      nowMs: HOUR_MS,
      planHistoryRecorder,
      activePlanRecorder,
    });

    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(markSpy).not.toHaveBeenCalled();
  });

  it('finalizes as `abandoned` and clears the active plan when the user removes the objective', () => {
    const planHistoryRecorder = buildHistoryRecorder();
    const activePlanRecorder = buildActiveRecorder();
    const finalizeSpy = vi.spyOn(planHistoryRecorder, 'finalizeForUserChange');
    const clearSpy = vi.spyOn(activePlanRecorder, 'clearForDevice');
    const markSpy = vi.spyOn(activePlanRecorder, 'markPending');

    applyDeferredObjectiveChange({
      deviceId: 'dev',
      deviceName: 'Boiler',
      prevEntry: tempEntry(),
      nextEntry: undefined,
      nowMs: HOUR_MS,
      planHistoryRecorder,
      activePlanRecorder,
    });

    expect(finalizeSpy).toHaveBeenCalledWith('dev', HOUR_MS, 'abandoned');
    expect(clearSpy).toHaveBeenCalledWith('dev');
    expect(markSpy).not.toHaveBeenCalled();
  });

  it('treats kind changes as a replacement', () => {
    const planHistoryRecorder = buildHistoryRecorder();
    const activePlanRecorder = buildActiveRecorder();
    const finalizeSpy = vi.spyOn(planHistoryRecorder, 'finalizeForUserChange');

    applyDeferredObjectiveChange({
      deviceId: 'dev',
      deviceName: 'EV',
      prevEntry: tempEntry(),
      nextEntry: evEntry(),
      nowMs: HOUR_MS,
      planHistoryRecorder,
      activePlanRecorder,
    });

    expect(finalizeSpy).toHaveBeenCalledWith('dev', HOUR_MS, 'replaced');
  });

  it('treats a disabled prior entry as no prior run', () => {
    const planHistoryRecorder = buildHistoryRecorder();
    const activePlanRecorder = buildActiveRecorder();
    const finalizeSpy = vi.spyOn(planHistoryRecorder, 'finalizeForUserChange');

    applyDeferredObjectiveChange({
      deviceId: 'dev',
      deviceName: 'Boiler',
      prevEntry: tempEntry({ enabled: false }),
      nextEntry: tempEntry({ targetTemperatureC: 70 }),
      nowMs: HOUR_MS,
      planHistoryRecorder,
      activePlanRecorder,
    });

    expect(finalizeSpy).not.toHaveBeenCalled();
  });

  // The deadline-passed gate: when the prior task's deadline has already
  // elapsed at the moment of the user change, the history recorder finalizes
  // the prior run synchronously as `'deadline_passed'` (→ met/missed) via
  // `finalizeElapsedDeadline` instead of the muted `'replaced'` / `'abandoned'`
  // shape via `finalizeForUserChange`. Synchronous finalization matters in
  // `power_source = flow` mode where the next plan cycle's sweep can be
  // arbitrarily delayed — a restart in that interval would otherwise drop the
  // entry. The active-plan side still swaps immediately so the live hero
  // updates without delay.
  describe('when the prior deadline has already elapsed at nowMs', () => {
    it('finalizes via finalizeElapsedDeadline (not finalizeForUserChange) and swaps the active plan', () => {
      const planHistoryRecorder = buildHistoryRecorder();
      const activePlanRecorder = buildActiveRecorder();
      const userChangeSpy = vi.spyOn(planHistoryRecorder, 'finalizeForUserChange');
      const elapsedSpy = vi.spyOn(planHistoryRecorder, 'finalizeElapsedDeadline');
      const clearSpy = vi.spyOn(activePlanRecorder, 'clearForDevice');
      const markSpy = vi.spyOn(activePlanRecorder, 'markPending');

      applyDeferredObjectiveChange({
        deviceId: 'dev',
        deviceName: 'Boiler',
        prevEntry: tempEntry({ deadlineAtMs: 6 * HOUR_MS }),
        nextEntry: tempEntry({ deadlineAtMs: 12 * HOUR_MS }),
        nowMs: 6 * HOUR_MS,
        planHistoryRecorder,
        activePlanRecorder,
      });

      expect(userChangeSpy).not.toHaveBeenCalled();
      expect(elapsedSpy).toHaveBeenCalledWith('dev', 6 * HOUR_MS);
      expect(clearSpy).not.toHaveBeenCalled();
      expect(markSpy).toHaveBeenCalledTimes(1);
      expect(markSpy.mock.calls[0]![0]!.deadlineAtMs).toBe(12 * HOUR_MS);
    });

    it('finalizes via finalizeElapsedDeadline when the user-change lands strictly after the deadline', () => {
      const planHistoryRecorder = buildHistoryRecorder();
      const activePlanRecorder = buildActiveRecorder();
      const userChangeSpy = vi.spyOn(planHistoryRecorder, 'finalizeForUserChange');
      const elapsedSpy = vi.spyOn(planHistoryRecorder, 'finalizeElapsedDeadline');

      applyDeferredObjectiveChange({
        deviceId: 'dev',
        deviceName: 'Boiler',
        prevEntry: tempEntry({ deadlineAtMs: 6 * HOUR_MS }),
        nextEntry: tempEntry({ deadlineAtMs: 12 * HOUR_MS }),
        nowMs: 6 * HOUR_MS + 1,
        planHistoryRecorder,
        activePlanRecorder,
      });

      expect(userChangeSpy).not.toHaveBeenCalled();
      expect(elapsedSpy).toHaveBeenCalledWith('dev', 6 * HOUR_MS + 1);
    });

    it('finalizes the clear branch via finalizeElapsedDeadline and drops the active plan', () => {
      const planHistoryRecorder = buildHistoryRecorder();
      const activePlanRecorder = buildActiveRecorder();
      const userChangeSpy = vi.spyOn(planHistoryRecorder, 'finalizeForUserChange');
      const elapsedSpy = vi.spyOn(planHistoryRecorder, 'finalizeElapsedDeadline');
      const clearSpy = vi.spyOn(activePlanRecorder, 'clearForDevice');
      const markSpy = vi.spyOn(activePlanRecorder, 'markPending');

      applyDeferredObjectiveChange({
        deviceId: 'dev',
        deviceName: 'Boiler',
        prevEntry: tempEntry({ deadlineAtMs: 6 * HOUR_MS }),
        nextEntry: undefined,
        nowMs: 6 * HOUR_MS,
        planHistoryRecorder,
        activePlanRecorder,
      });

      expect(userChangeSpy).not.toHaveBeenCalled();
      expect(elapsedSpy).toHaveBeenCalledWith('dev', 6 * HOUR_MS);
      expect(clearSpy).toHaveBeenCalledWith('dev');
      expect(markSpy).not.toHaveBeenCalled();
    });

    it('still calls finalizeForUserChange when the deadline is one millisecond in the future', () => {
      const planHistoryRecorder = buildHistoryRecorder();
      const activePlanRecorder = buildActiveRecorder();
      const userChangeSpy = vi.spyOn(planHistoryRecorder, 'finalizeForUserChange');
      const elapsedSpy = vi.spyOn(planHistoryRecorder, 'finalizeElapsedDeadline');

      applyDeferredObjectiveChange({
        deviceId: 'dev',
        deviceName: 'Boiler',
        prevEntry: tempEntry({ deadlineAtMs: 6 * HOUR_MS + 1 }),
        nextEntry: tempEntry({ deadlineAtMs: 12 * HOUR_MS }),
        nowMs: 6 * HOUR_MS,
        planHistoryRecorder,
        activePlanRecorder,
      });

      expect(userChangeSpy).toHaveBeenCalledWith('dev', 6 * HOUR_MS, 'replaced');
      expect(elapsedSpy).not.toHaveBeenCalled();
    });
  });
});
