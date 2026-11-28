import { buildDeviceStatus } from '../../lib/plan/deviceStatusReadModel';
import type { DeviceStatusInput } from '../../lib/plan/deviceStatusInput';
import { withChargingInstallation } from '../../lib/plan/chargingInstallationCardText';
import { PLAN_REASON_CODES, type DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';

const runningPowerHold = (overrides: Partial<DeviceStatusInput> = {}): DeviceStatusInput => ({
  currentState: 'on', plannedState: 'shed', binaryControllable: true, isEvCharger: false,
  currentDrawKw: 1.2, expectedPowerKw: 1.5, controllable: true, available: true,
  reason: { code: PLAN_REASON_CODES.capacity, shortfallKw: 2.3 },
  priceTargetShift: { kind: 'none' }, adapterUnavailableStatus: undefined, chargingInstallation: undefined, unusedBuiltInControl: 'none', targetPowerControlRefused: false,
  standingCommandGrant: true, powerLimitControlEnabled: true, hasPowerReading: true, powerSetupRequirement: null,
  powerBeforeSwitchOffKw: undefined,
  carIdentificationState: 'not_waiting',
  execution: {
    available: true, physicalState: 'on', observedStepId: null,
    desiredBinary: 'off', desiredStepId: null, binaryProgress: 'unmet',
    stepProgress: 'undriven', targetProgress: 'undriven', resumeExpected: false,
    steppedTransitionPending: false, stepCommandUnanswered: false, externalOffHeld: false,
  },
  ...overrides,
});

describe('last-resort relay reporting its own power', () => {
  const relay = (currentDrawKw?: number, controllable = true): DeviceStatusInput => runningPowerHold({
    plannedState: 'keep', reason: { code: PLAN_REASON_CODES.keep, detail: null },
    lastResort: { maximumW: 2_000 }, currentDrawKw, controllable,
    expectedPowerKw: 2, hasPowerReading: false,
  });

  it.each([true, false])('shows the measured power and withdraws Ease off with plan authority=%s', (controllable) => {
    for (const draw of [0, 0.42]) {
      expect(buildDeviceStatus(relay(draw, controllable), false, 0)).toMatchObject({
        label: 'Manual', canEaseOff: false, controlOffDrawing: draw > 0,
        powerText: draw === 0 ? '0.0 kW' : '0.4 kW',
        reason: { text: 'Has its own power reading. Turn off last-resort control under Power limiting.' },
      });
    }
  });

  it('keeps the unmetered, unavailable and pending switch-off states', () => {
    const running = relay(0.42);
    expect(buildDeviceStatus(relay(), false, 0)).toMatchObject({ label: 'On', powerText: null });
    expect(buildDeviceStatus({
      ...running, execution: { ...running.execution, available: false },
    }, false, 0)).toMatchObject({ label: 'Unavailable', powerText: null });
    expect(buildDeviceStatus({
      ...running, plannedState: 'shed', reason: { code: PLAN_REASON_CODES.capacity, shortfallKw: 1 },
      execution: { ...running.execution, binaryProgress: 'pending' },
    }, false, 0)).toMatchObject({ kind: 'held', powerText: null });
  });
});

describe('last-resort relay whose maximum can never fit', () => {
  const offRelay = (limit: 'capacity' | 'grid'): DeviceStatusInput => runningPowerHold({
    currentState: 'off', plannedState: 'shed', currentDrawKw: undefined, expectedPowerKw: 6, hasPowerReading: false,
    lastResort: { maximumW: 6_000, observedOffAtMs: 0 }, lastResortOwnedOffAtMs: 0,
    reason: { code: PLAN_REASON_CODES.lastResortAboveLimit, maximumKw: 6, limitKw: 4.8, limit },
    execution: {
      available: true, physicalState: 'off', observedStepId: null,
      desiredBinary: 'off', desiredStepId: null, binaryProgress: 'settled',
      stepProgress: 'undriven', targetProgress: 'undriven', resumeExpected: false,
      steppedTransitionPending: false, stepCommandUnanswered: false, externalOffHeld: false,
    },
  });

  it.each([
    ['capacity', 'your hard cap (4.8 kW after the safety margin)'],
    ['grid', 'your grid import limit, which PELS keeps at 4.8 kW'],
  ] as const)('warns on the card and names the %s limit', (limit, named) => {
    expect(buildDeviceStatus(offRelay(limit), false, 0).reason).toEqual({
      text: `Maximum power draw 6.0 kW plus room for its start does not fit under ${named}, so PELS turns it on `
        + 'only while solar or a battery makes room. Lower it under Power limiting.',
      tone: 'warning',
    });
  });
});

describe('simulation action previews', () => {
  const modeTemperature = (plannedTarget: number, controllable: boolean): DeviceStatusInput => {
    const device = runningPowerHold();
    return {
      ...device, controllable, binaryControllable: false, currentState: 'not_applicable', plannedState: 'keep',
      reason: controllable
        ? { code: PLAN_REASON_CODES.keep, detail: null } : { code: PLAN_REASON_CODES.capacityControlOff },
      temperature: { currentTemperature: 50, currentTarget: 55, plannedTarget, thermalDirection: 'heating' },
      execution: { ...device.execution, physicalState: 'not_applicable', desiredBinary: null,
        binaryProgress: 'undriven', targetProgress: 'unmet' },
    };
  };

  it.each([true, false])('previews ordinary mode targets with power-control authority=%s', (controllable) => {
    for (const target of [40, 60]) {
      const status = buildDeviceStatus(modeTemperature(target, controllable), true, 0);
      expect(status).toMatchObject({ label: 'Running', limited: false, wouldLimit: false,
        canEaseOff: controllable, controlOffDrawing: !controllable,
        factText: `50.0 °C · set to 55 °C → planned ${target} °C`,
        reading: { kind: 'temperature', currentC: 50, targetC: target },
        reason: { text: `Would set target to ${target} °C (simulation)` },
      });
    }
  });

  it.each([false, true])('keeps a settled mode-only thermostat factual in simulation=%s', (dryRun) => {
    const device = modeTemperature(55, false);
    const status = buildDeviceStatus({ ...device,
      execution: { ...device.execution, targetProgress: 'settled' },
    }, dryRun, 0);
    expect(status).toMatchObject({ label: 'Running', reason: null, limited: false, wouldLimit: false,
      canEaseOff: false, controlOffDrawing: true });
  });

  it.each(['undriven', 'unavailable', 'external_off'] as const)(
    'does not preview an ordinary target when %s', (gate) => {
      const device = modeTemperature(40, false);
      const status = buildDeviceStatus({ ...device,
        execution: { ...device.execution, targetProgress: gate === 'undriven' ? 'undriven' : 'unmet',
          available: gate !== 'unavailable', externalOffHeld: gate === 'external_off' },
      }, true, 0);
      expect(status.reason).toBeNull();
      if (gate === 'undriven') expect(status.label).toBe('Manual');
      if (gate === 'unavailable') expect(status.label).toBe('Unavailable');
    },
  );

  it('marks a device with an override in force, also while it is limited', () => {
    const kept = buildDeviceStatus({ ...modeTemperature(60, false), temporaryTemperatureActive: true }, false, 0);
    expect(kept.override).toBe(true);
    expect(kept.reason).toBeNull();
    expect(buildDeviceStatus(runningPowerHold({ temporaryTemperatureActive: true }), false, 0).override).toBe(true);
    expect(buildDeviceStatus(modeTemperature(60, false), false, 0)).not.toHaveProperty('override');
  });

  it('names the device\'s setpoint and the one PELS plans to set, also while it holds the device off', () => {
    // Prod 2026-11-17: an override of 22 on a thermostat PELS had turned off at
    // 28. No write goes out while it is off, and the card read only `target 28 °C`.
    const device = runningPowerHold();
    const heldOff: DeviceStatusInput = {
      ...device, currentState: 'off', currentDrawKw: 0,
      temperature: { currentTemperature: 21.9, currentTarget: 28, plannedTarget: 22, thermalDirection: 'heating' },
      execution: { ...device.execution, physicalState: 'off', targetProgress: 'undriven' },
    };

    const status = buildDeviceStatus(heldOff, false, 0);
    expect(status.factText).toBe('21.9 °C · set to 28 °C → planned 22 °C');
    // The device page header says which side is which, when and why.
    expect(status.targetDetail).toBe('Set to 28 °C. PELS sets 22 °C when it resumes the device.');
    expect(buildDeviceStatus({ ...heldOff, temporaryTemperatureActive: true }, false, 0).targetDetail)
      .toBe('Set to 28 °C. PELS sets 22 °C when it resumes the device (override).');
    const driven = { ...heldOff, execution: { ...heldOff.execution, targetProgress: 'pending' as const } };
    expect(buildDeviceStatus(driven, false, 0).targetDetail).toBe('Set to 28 °C. PELS is setting 22 °C.');
    expect(buildDeviceStatus(driven, true, 0).targetDetail)
      .toBe('Set to 28 °C. In simulation PELS changes nothing; it would set 22 °C.');
    const shifted = { ...driven, priceTargetShift: { kind: 'shifted', direction: 'lowered', priceLevel: 'expensive' } as const };
    expect(buildDeviceStatus(shifted, false, 0).targetDetail)
      .toBe('Set to 28 °C. PELS is setting 22 °C (lowered while power is expensive).');
    expect(status.reading).toMatchObject({ targetC: 22 });
    // One value when the device already sits where PELS wants it.
    const settled: DeviceStatusInput = {
      ...heldOff,
      temperature: { currentTemperature: 21.9, currentTarget: 28, plannedTarget: 28, thermalDirection: 'heating' },
    };
    expect(buildDeviceStatus(settled, false, 0).factText).toBe('21.9 °C · target 28 °C');
    expect(buildDeviceStatus(settled, false, 0)).not.toHaveProperty('targetDetail');
  });

  it('names only the device\'s setpoint while a finished Smart task holds it until its ready-by time', () => {
    // The plan's target is still the task's 20, but PELS writes nothing to a
    // device it holds off, and at the ready-by time the mode's target applies.
    const device = runningPowerHold();
    const held = (code: DeviceReason['code']): DeviceStatusInput => ({
      ...device, currentState: 'off', currentDrawKw: 0, reason: { code } as DeviceReason,
      temperature: { currentTemperature: 20.7, currentTarget: 18, plannedTarget: 20, thermalDirection: 'heating' },
      execution: { ...device.execution, physicalState: 'off', targetProgress: 'undriven' },
    });

    const done = buildDeviceStatus(held(PLAN_REASON_CODES.deferredObjectiveSatisfied), false, 0);
    expect(done.factText).toBe('20.7 °C · target 18 °C');
    expect(done.reading).toMatchObject({ targetC: 18 });
    // A task still waiting for cheaper hours will run and set its target: the arrow stays.
    expect(buildDeviceStatus(held(PLAN_REASON_CODES.deferredObjectiveAvoid), false, 0).factText)
      .toBe('20.7 °C · set to 18 °C → planned 20 °C');
    expect(buildDeviceStatus(held(PLAN_REASON_CODES.deferredObjectiveAvoid), false, 0).targetDetail)
      .toBe('Set to 18 °C. PELS sets 20 °C when the Smart task runs.');
    expect(done).not.toHaveProperty('targetDetail');
  });

  it('does not use hypothetical wording for an ordinary live target change', () => {
    expect(buildDeviceStatus(modeTemperature(60, false), false, 0).reason).toBeNull();
  });

  it('keeps device warning guidance ahead of an ordinary mode target preview', () => {
    const status = buildDeviceStatus({ ...modeTemperature(60, true), idleClassification: 'unresponsive' }, true, 0);
    expect(status.reason).toMatchObject({ tone: 'warning' });
    expect(status.reason?.text).not.toContain('Would set target');
  });

  it('does not replace an off device resume explanation with its temperature preparation', () => {
    const device = modeTemperature(60, true);
    const status = buildDeviceStatus({ ...device, binaryControllable: true, currentState: 'off', currentDrawKw: 0,
      execution: { ...device.execution, physicalState: 'off', resumeExpected: true, desiredBinary: 'on' },
    }, true, 0);
    expect(status.label).toBe('Off');
    expect(status.reason).toBeNull();
  });

  it('shows the planned off action instead of treating a running load as a failed pause', () => {
    const status = buildDeviceStatus(runningPowerHold(), true, 0);
    expect(status).toMatchObject({ label: 'Running', powerText: '1.2 kW', limited: true, wouldLimit: true });
    expect(status.reason).toEqual({ text: 'Would turn off (simulation)' });
  });

  it('explains the off action on a thermostat that still reports its own temperature and target', () => {
    const status = buildDeviceStatus(runningPowerHold({
      temperature: { currentTemperature: 20, currentTarget: 21, plannedTarget: 21, thermalDirection: 'heating' },
    }), true, 0);
    expect(status.label).toBe('Running');
    expect(status.factText).toBe('20.0 °C · target 21 °C');
    expect(status.reason).toEqual({ text: 'Would turn off (simulation)' });
  });

  it.each<DeviceReason>([
    { code: PLAN_REASON_CODES.shortfall },
    { code: PLAN_REASON_CODES.hourlyBudget },
    { code: PLAN_REASON_CODES.endOfHourDrain },
    { code: PLAN_REASON_CODES.dailyBudget },
    { code: PLAN_REASON_CODES.gridImport },
    { code: PLAN_REASON_CODES.phaseLimit, phase: 'L1' },
    { code: PLAN_REASON_CODES.meterSilent },
  ])('previews the command for $code without a resume shortfall or countdown', (reason) => {
    expect(buildDeviceStatus(runningPowerHold({ reason }), true, 0).reason)
      .toEqual({ text: 'Would turn off (simulation)' });
  });

  it('preserves the phase-setting offer beside the proposed action', () => {
    const status = buildDeviceStatus(runningPowerHold({
      reason: { code: PLAN_REASON_CODES.phaseLimit, phase: 'L1' },
      phaseFootprint: { kind: 'unknown' },
    }), true, 0);
    expect(status.reason).toEqual({ text: 'Would turn off (simulation)', offersPhaseSetting: true });
  });

  it.each([
    { currentTarget: 21, plannedTarget: 15.5, thermalDirection: 'heating' as const },
    { currentTarget: 21, plannedTarget: 25.5, thermalDirection: 'cooling' as const },
  ])('shows the exact decided temperature target for $thermalDirection', (temperature) => {
    const device = runningPowerHold();
    const status = buildDeviceStatus({ ...device,
      temperature: { ...temperature, currentTemperature: 20 },
      execution: { ...device.execution, desiredBinary: null, binaryProgress: 'undriven', targetProgress: 'unmet' },
    }, true, 0);
    expect(status.reason).toEqual({ text: `Would set target to ${temperature.plannedTarget} °C (simulation)` });
    expect(status.factText).toBe(`20.0 °C · set to 21 °C → planned ${temperature.plannedTarget} °C`);
  });

  it('formats an arithmetic temperature target consistently in the fact and preview', () => {
    const device = runningPowerHold();
    const status = buildDeviceStatus({ ...device,
      temperature: { currentTemperature: 20, currentTarget: 21, plannedTarget: 15.499999999999998,
        thermalDirection: 'heating' },
      execution: { ...device.execution, desiredBinary: null, targetProgress: 'unmet' },
    }, true, 0);
    expect(status.factText).toBe('20.0 °C · set to 21 °C → planned 15.5 °C');
    expect(status.reason?.text).toBe('Would set target to 15.5 °C (simulation)');
  });

  it.each(['unmet', 'undriven'] as const)('handles a target-only thermostat with %s target progress', (targetProgress) => {
    const device = runningPowerHold();
    const status = buildDeviceStatus({ ...device, currentState: 'not_applicable', binaryControllable: false,
      temperature: { currentTemperature: 20, currentTarget: 21, plannedTarget: 15.5, thermalDirection: 'heating' },
      execution: { ...device.execution, physicalState: 'not_applicable', desiredBinary: null,
        binaryProgress: 'undriven', targetProgress },
    }, true, 0);
    if (targetProgress === 'unmet') {
      expect(status.reason?.text).toBe('Would set target to 15.5 °C (simulation)');
    } else {
      expect(status.reason?.text).not.toContain('Would set target');
    }
    expect(status.reason?.text).not.toContain('Would turn off');
  });

  const steppedHold = () => {
    const device = runningPowerHold();
    return { ...device, steppedLoad: {
      profile: { steps: [
        { id: 'off', planningPowerW: 0 }, { id: '6a', planningPowerW: 1380 }, { id: '16a', planningPowerW: 3680 },
      ] },
      reportedStepId: '16a', targetStepId: '6a', selectedStepId: '16a', planningPowerKw: 3.68, commandPending: false,
    }, execution: { ...device.execution,
      desiredBinary: 'on', binaryProgress: 'settled', observedStepId: '16a', desiredStepId: '6a', stepProgress: 'unmet',
    } } satisfies DeviceStatusInput;
  };

  it('names the decided level without claiming the real charger has reduced its draw', () => {
    const status = buildDeviceStatus(steppedHold(), true, 0);
    expect(status.label).toBe('Running');
    expect(status.reason).toEqual({ text: 'Would set level to 6 A (simulation)' });
  });

  it('offers a problem report for an unanswered live level change', () => {
    const device = steppedHold();
    const unanswered = { ...device, execution: { ...device.execution, stepCommandUnanswered: true } };
    expect(buildDeviceStatus(unanswered, false, 0).reason).toMatchObject({
      text: 'Level change not confirmed — check the Flows that set and report the level',
      tone: 'warning', offersProblemReport: true,
    });
    expect(buildDeviceStatus(unanswered, true, 0).reason).not.toHaveProperty('offersProblemReport');
    expect(buildDeviceStatus(device, false, 0).reason).not.toHaveProperty('offersProblemReport');
    const identifying = { ...unanswered, carIdentificationState: 'timed_out' as const };
    expect(buildDeviceStatus(identifying, false, 0).reason).toHaveProperty('offersCarConfirmation', true);
    expect(buildDeviceStatus(identifying, false, 0).reason).not.toHaveProperty('offersProblemReport');
  });

  it('keeps a stepped thermostat target consistent with its simulated target command', () => {
    const device = steppedHold();
    const status = buildDeviceStatus({ ...device,
      temperature: { currentTemperature: 50, currentTarget: 60, plannedTarget: 55.5, thermalDirection: 'heating' },
      execution: { ...device.execution, desiredStepId: '16a', stepProgress: 'settled', targetProgress: 'unmet' },
    }, true, 0);
    expect(status.factText).toBe('50.0 °C · set to 60 °C → planned 55.5 °C');
    expect(status.reason?.text).toBe('Would set target to 55.5 °C (simulation)');
  });

  it('names an off decision on the stepped axis as turning off', () => {
    const device = steppedHold();
    const status = buildDeviceStatus({ ...device,
      execution: { ...device.execution, desiredBinary: 'off', desiredStepId: 'off' },
    }, true, 0);
    expect(status.reason).toEqual({ text: 'Would turn off (simulation)' });
  });

  it('does not describe an unconfirmed planner-only level missing from the confirmed ladder', () => {
    const device = steppedHold();
    const status = buildDeviceStatus({ ...device,
      execution: { ...device.execution, desiredStepId: '32a' },
    }, true, 0);
    expect(status.reason?.text).not.toContain('32 A');
  });

  it('keeps the existing waiting explanation when there is no command to preview', () => {
    const device = runningPowerHold();
    const status = buildDeviceStatus({ ...device, currentDrawKw: undefined,
      execution: { ...device.execution, desiredBinary: null, binaryProgress: 'undriven' },
    }, true, 0);
    expect(status.reason?.text).toBe('Would be waiting to resume — 2.3 kW more needed (simulation)');
  });

  it('does not infer a temperature command from the planned target alone', () => {
    const device = runningPowerHold();
    const status = buildDeviceStatus({ ...device,
      temperature: { currentTemperature: 20, currentTarget: 21, plannedTarget: 15, thermalDirection: 'heating' },
      execution: { ...device.execution, desiredBinary: null, binaryProgress: 'undriven' },
    }, true, 0);
    expect(status.reason?.text).not.toContain('Would set target');
    // The fact line still names both: the device's setpoint and the one planned.
    expect(status.factText).toBe('20.0 °C · set to 21 °C → planned 15 °C');
  });

  it('keeps the waiting explanation once the real device is already off', () => {
    const device = runningPowerHold();
    const status = buildDeviceStatus({ ...device, currentState: 'off', currentDrawKw: 0,
      execution: { ...device.execution, physicalState: 'off', binaryProgress: 'settled' },
    }, true, 0);
    expect(status.reason?.text).toBe('Would be waiting to resume — 2.3 kW more needed (simulation)');
  });

  it('keeps the smart task explanation instead of replacing it with an off action', () => {
    const status = buildDeviceStatus(runningPowerHold({
      temperature: { currentTemperature: 20, currentTarget: 21, plannedTarget: 21, thermalDirection: 'heating' },
      reason: { code: PLAN_REASON_CODES.deferredObjectiveAvoid },
    }), true, 0);
    expect(status.reason?.text).toBe('Would wait for cheaper hours (simulation)');
  });

  it('keeps the settled-level waiting explanation', () => {
    const device = steppedHold();
    const status = buildDeviceStatus({ ...device,
      execution: { ...device.execution, desiredStepId: '16a', stepProgress: 'settled' },
    }, true, 0);
    expect(status.reason?.text).not.toContain('Would set level');
  });

  it('names the reported level when a fairness hold also carries a decided level in simulation', () => {
    const status = buildDeviceStatus({ ...steppedHold(),
      steppedFairnessHold: { limitedDeviceCount: 2 },
    }, true, 0);
    expect(status.reason).toEqual({ text: 'Would be holding at 16 A — cannot increase while 2 devices are limited (simulation)' });
  });

  it.each([
    ['on', '6a', 'Holding at 6 A'],
    ['on', null, 'Holding'],
    ['off', '6a', 'Holding'],
  ] as const)('shows the fairness reason without a countdown when %s with report %s', (physicalState, stepId, stem) => {
    const device = steppedHold();
    const steppedLoad = { ...device.steppedLoad, reportedStepId: stepId };
    const status = buildDeviceStatus({
      ...device, steppedLoad, currentState: physicalState,
      reason: { code: PLAN_REASON_CODES.cooldownShedding, remainingSec: 30 },
      steppedFairnessHold: { limitedDeviceCount: 2 },
      execution: { ...device.execution, physicalState, observedStepId: stepId },
    }, false, 0);
    expect(status.reason).toEqual({ text: `${stem} — cannot increase while 2 devices are limited` });
  });

  it('keeps the explanation for a running device held below its top level', () => {
    const status = buildDeviceStatus({ ...steppedHold(), steppedStepUpHold: true }, true, 0);
    expect(status.reason?.text).toBe('Would be waiting to increase (simulation)');
  });

  it('preserves the reported-power framing after a live binary limit', () => {
    const status = buildDeviceStatus(runningPowerHold(), false, 0);
    expect(status).toMatchObject({ powerText: 'Reported 1.2 kW', powerVariant: 'reported', wouldLimit: false });
  });

  it.each([false, true])('preserves measured draw from an off binary device in simulation=%s', (dryRun) => {
    const device = runningPowerHold();
    const status = buildDeviceStatus({ ...device, currentState: 'off', currentDrawKw: 0.4,
      powerBeforeSwitchOffKw: dryRun ? 0.4 : undefined,
      execution: { ...device.execution, physicalState: 'off', binaryProgress: 'settled' },
    }, dryRun, 0);
    expect(status).toMatchObject({
      powerText: dryRun ? '0.4 kW' : 'Reported 0.4 kW', powerVariant: dryRun ? 'live' : 'reported',
    });
    expect(status.reason?.text).not.toContain('Would turn off');
  });

  it('keeps pending binary commands and thermostat holds out of the switch-off warning', () => {
    const device = runningPowerHold({ currentState: 'off', powerBeforeSwitchOffKw: 1.2 });
    const off = { ...device.execution, physicalState: 'off' } as const;
    const pending = buildDeviceStatus({ ...device, execution: { ...off, binaryProgress: 'pending' } }, false, 0);
    const thermostat = buildDeviceStatus({ ...device, execution: { ...off, binaryProgress: 'settled' },
      temperature: { currentTemperature: 20, currentTarget: 21, plannedTarget: 21, thermalDirection: 'heating' },
    }, false, 0);
    for (const status of [pending, thermostat]) {
      expect(status.powerVariant).not.toBe('before_switch_off');
      expect(status.powerText).not.toContain('Last reported');
    }
  });

  it('preserves the live thermostat hold explanation', () => {
    const status = buildDeviceStatus(runningPowerHold({
      temperature: { currentTemperature: 20, currentTarget: 21, plannedTarget: 21, thermalDirection: 'heating' },
    }), false, 0);
    expect(status.label).toBe('Limited');
    expect(status.reason?.text).toBe('Waiting to resume — 2.3 kW more needed');
    expect(status.wouldLimit).toBe(false);
  });
});

describe('a device whose app refused level control', () => {
  const kept = (overrides: Partial<DeviceStatusInput> = {}) => buildDeviceStatus(runningPowerHold({
    plannedState: 'keep', reason: { code: PLAN_REASON_CODES.keep, detail: null }, targetPowerControlRefused: true,
    execution: { ...runningPowerHold().execution, desiredBinary: 'on', binaryProgress: 'settled' },
    ...overrides,
  }), false, 0);

  it('says PELS can only switch it, where the card has nothing else to say', () => {
    expect(kept().reason).toEqual({
      text: 'PELS can only turn it on and off: its app does not accept level control', tone: 'warning',
    });
  });

  it('keeps the hold reason of a limited device', () => {
    const status = kept({ plannedState: 'shed', reason: { code: PLAN_REASON_CODES.capacity, shortfallKw: 2.3 } });
    expect(status.reason?.text).not.toContain('level control');
  });

  it('says nothing for a device with level control', () => {
    expect(kept({ targetPowerControlRefused: false }).reason).toBeNull();
  });
});

describe('Manual cards', () => {
  // Every card PELS does not control says why (owner, 2026-11-14), and names only
  // what the facts say: the owner's grant first, then the power reading.
  const manual = (overrides: Partial<DeviceStatusInput>, dryRun = false) => buildDeviceStatus(runningPowerHold({
    controllable: false, plannedState: 'keep', reason: { code: PLAN_REASON_CODES.capacityControlOff }, ...overrides,
  }), dryRun, 0);

  it.each([false, true])('names Homey Energy setup before command grants, granted=%s', (standingCommandGrant) => {
    const status = manual({ standingCommandGrant, hasPowerReading: false, powerSetupRequirement: { kind: 'homey_energy' },
      currentDrawKw: undefined });
    expect(status.kind).toBe('manual');
    expect(status.reason).toMatchObject({ tone: 'warning', offersHomeyEnergySetup: true });
    expect(status.reason?.text).toContain('Advanced settings in Homey');
    expect(status.reason?.text).toContain('under Power limiting');
    expect(status.powerText).toBeNull();
  });

  it.each([false, true])('names Power-limit control when the owner granted none, in simulation %s', (dryRun) => {
    const status = manual({ standingCommandGrant: false }, dryRun);
    expect(status.label).toBe('Manual');
    expect(status.reason).toEqual({ text: 'Power-limit control is off' });
  });

  it('names Power-limit control over a missing power reading when both hold', () => {
    expect(manual({ standingCommandGrant: false, hasPowerReading: false }).reason)
      .toEqual({ text: 'Power-limit control is off' });
  });

  it('says there is no power reading when the owner granted control', () => {
    const status = manual({ standingCommandGrant: true, hasPowerReading: false });
    expect(status.label).toBe('Manual');
    expect(status.reason).toEqual({ text: 'No power reading from this device' });
  });

  it('names no setting the owner has turned on when no fact explains it', () => {
    expect(manual({ standingCommandGrant: true, hasPowerReading: true }).reason).toBeNull();
  });
});

describe('Unavailable cards', () => {
  // Unavailable is Homey's word (owner, 2026-11-14), and the card says so.
  it('says Homey reports the device unavailable', () => {
    const device = runningPowerHold({ available: false, plannedState: 'keep', reason: { code: PLAN_REASON_CODES.keep, detail: null } });
    const status = buildDeviceStatus({ ...device, execution: { ...device.execution, available: false } }, false, 0);
    expect(status.label).toBe('Unavailable');
    expect(status.reason).toEqual({ text: 'Homey reports this device unavailable' });
  });

  it('claims nothing for an available device whose plan could not be built', () => {
    const device = runningPowerHold({ plannedState: 'keep', reason: { code: PLAN_REASON_CODES.keep, detail: null } });
    const status = buildDeviceStatus({ ...device, execution: { ...device.execution, available: false } }, false, 0);
    expect(status.label).toBe('Unavailable');
    expect(status.reason).toBeNull();
  });
});

describe('live charging between plan builds', () => {
  const charger = runningPowerHold({
    isEvCharger: true, plannedState: 'inactive', reason: { code: PLAN_REASON_CODES.keep, detail: null },
    evChargingState: 'plugged_in_charging', currentDrawKw: 3.6,
    steppedLoad: {
      profile: { steps: [{ id: 'off', planningPowerW: 0 }, { id: '32a', planningPowerW: 7360 }] },
      reportedStepId: '32a', targetStepId: null, selectedStepId: '32a', planningPowerKw: 7.36, commandPending: false,
    },
    execution: { ...runningPowerHold().execution, observedStepId: '32a', desiredBinary: null, binaryProgress: 'undriven' },
  });

  it.each([false, true])('shows a newly observed charge with an unchanged inactive plan in simulation=%s', (dryRun) => {
    const before = buildDeviceStatus({
      ...charger, currentState: 'off', evChargingState: 'plugged_in', currentDrawKw: 0,
      execution: { ...charger.execution, physicalState: 'off' },
    }, dryRun, 0);
    expect(before.label).toBe('Off');
    expect(buildDeviceStatus(charger, dryRun, 0)).toMatchObject({
      label: 'Running', powerText: '3.6 kW', factText: 'Charging · level 32 A', reason: null,
    });
  });

  it.each([
    { overrides: { currentDrawKw: 0 }, kind: 'idle' },
    { overrides: { evChargingState: 'plugged_in_paused' }, kind: 'idle' },
    { overrides: { execution: { ...charger.execution, externalOffHeld: true } }, kind: 'idle' },
    { overrides: { reason: { code: PLAN_REASON_CODES.deferredObjectiveAvoid } }, kind: 'held' },
    { overrides: { reason: { code: PLAN_REASON_CODES.chargeTargetReached, targetPercent: 80 } }, kind: 'active' },
    { overrides: { controllable: false }, kind: 'manual' },
    { overrides: { execution: { ...charger.execution, available: false } }, kind: 'unavailable' },
  ] satisfies Array<{ overrides: Partial<DeviceStatusInput>; kind: string }>)('reads $kind with $overrides', ({
    overrides, kind,
  }) => {
    expect(buildDeviceStatus({ ...charger, ...overrides }, false, 0).kind).toBe(kind);
  });
});

describe('power readings on a held relay', () => {
  const held = runningPowerHold();
  it.each([
    ['awaiting_power', 'Waiting for a power reading after switch-off'],
    ['post_command', 'Reported 1.2 kW after switch-off'],
    ['relieved', 'Reported 1.2 kW after switch-off'],
    ['off_with_draw', 'Reports off, still drawing 1.2 kW'],
  ] as const)('describes %s under an observed OFF', (relayShedPowerEvidence, expected) => {
    const device: DeviceStatusInput = { ...held, currentState: 'off', plannedState: 'shed',
      execution: { ...held.execution, physicalState: 'off', relayShedPowerEvidence } };
    expect(buildDeviceStatus(device, false, 0).reason?.text).toContain(expected);
  });
});

describe('charger app update warning', () => {
  it('flags a charger whose selected built-in current control needs an app update', () => {
    expect(buildDeviceStatus(runningPowerHold({ isEvCharger: true, unusedBuiltInControl: 'needs_app_update' }), false, 0))
      .toMatchObject({ needsChargerAppUpdate: true });
  });

  it.each(['none', 'held_by_flow', 'not_set_up'] as const)('leaves the flag off for %s', (unusedBuiltInControl) => {
    expect(buildDeviceStatus(runningPowerHold({ isEvCharger: true, unusedBuiltInControl }), false, 0))
      .not.toHaveProperty('needsChargerAppUpdate');
  });
});

describe('mode preparation reason', () => {
  const modePreparation = { targetC: 65, mode: 'Home', at: '08:05' };
  const preparing = (overrides: Partial<DeviceStatusInput> = {}): DeviceStatusInput => {
    const device = runningPowerHold();
    return {
      ...device, plannedState: 'keep', reason: { code: PLAN_REASON_CODES.keep, detail: null },
      temperature: { currentTemperature: 58, currentTarget: 65, plannedTarget: 65, thermalDirection: 'heating' },
      modePreparation,
      execution: { ...device.execution, desiredBinary: 'on', binaryProgress: 'settled', targetProgress: 'settled' },
      ...overrides,
    };
  };
  const stepped = {
    profile: { steps: [
      { id: 'off', planningPowerW: 0 }, { id: 'low', planningPowerW: 1250 }, { id: 'max', planningPowerW: 3000 },
    ] },
    reportedStepId: 'max', targetStepId: 'max', selectedStepId: 'max', planningPowerKw: 3, commandPending: false,
  };

  it('explains the early target on a thermostat card', () => {
    expect(buildDeviceStatus(preparing(), false, 0).reason).toEqual({ text: 'Getting ready for Home at 08:05' });
  });

  it('explains the early target on a stepped water heater card', () => {
    const device = preparing({ steppedLoad: stepped });
    const status = buildDeviceStatus({ ...device, execution: { ...device.execution,
      observedStepId: 'max', desiredStepId: 'max', stepProgress: 'settled' } }, false, 0);
    expect(status.reason).toEqual({ text: 'Getting ready for Home at 08:05' });
  });

  it('keeps a power hold ahead of the early target', () => {
    const status = buildDeviceStatus(runningPowerHold({ modePreparation,
      temperature: { currentTemperature: 58, currentTarget: 65, plannedTarget: 65, thermalDirection: 'heating' } }),
    false, 0);
    expect(status.reason?.text).not.toContain('Getting ready');
  });
});

describe('charging installation controlled as one load', () => {
  const card = (chargingInstallation: DeviceStatusInput['chargingInstallation'], overrides: Partial<DeviceStatusInput> = {}) => (
    runningPowerHold({
      isEvCharger: true, plannedState: 'keep', reason: { code: PLAN_REASON_CODES.keep, detail: null },
      chargingInstallation, currentDrawKw: 3.2,
      execution: { ...runningPowerHold().execution, desiredBinary: 'on', binaryProgress: 'settled' },
      ...overrides,
    }));
  const status = (device: DeviceStatusInput) => withChargingInstallation(device, buildDeviceStatus(device, false, 0));

  it('keeps the installation total on the main\'s power line beside its own draw, whatever the reason line says', () => {
    const main = status(card({ role: 'main', totalKw: 10.4 }));
    expect(main.powerText).toBe('3.2 kW · installation 10.4 kW');
    expect(main.reason?.text).toBe('Sets the available current for this installation.');
    const held = status(card({ role: 'main', totalKw: 10.4 }, {
      plannedState: 'shed', reason: { code: PLAN_REASON_CODES.capacity, shortfallKw: 2.3 },
    }));
    expect(held.powerText).toContain('installation 10.4 kW');
    expect(held.reason?.text).not.toBe('Sets the available current for this installation.');
  });

  it('keeps the secondary reading when the installation main has no name in the plan', () => {
    const secondary = status(card({ role: 'secondary', mainName: undefined }));
    expect(secondary).toMatchObject({ label: 'Running', factText: 'Charging', powerText: '3.2 kW', reason: null });
  });

  it('shows why a task-only primary is off while its sibling charges', () => {
    const primary = status(card({ role: 'main', totalKw: 3.2 }, {
      currentState: 'off', currentDrawKw: 0, startPolicyHoldActive: true,
      execution: { ...runningPowerHold().execution, physicalState: 'off', desiredBinary: 'off', resumeExpected: false },
    }));
    expect(primary).toMatchObject({
      kind: 'off',
      powerText: '0.0 kW · installation 3.2 kW',
      reason: { text: 'Waiting for a smart task' },
    });
  });

  it.each([
    [PLAN_REASON_CODES.awaitingPelsStart, 'Waiting for a smart task'],
    [PLAN_REASON_CODES.deferredObjectiveAvoid, 'Waiting for cheaper hours'],
    [PLAN_REASON_CODES.deferredObjectiveSatisfied, 'Smart task done, held until its ready-by time'],
  ] as const)('keeps a secondary charger’s task hold reason (%s)', (code, text) => {
    const secondary = status(card({ role: 'secondary', mainName: 'Garage' }, {
      plannedState: 'inactive', currentState: 'off', currentDrawKw: 0,
      evChargingState: 'plugged_in_paused', reason: { code },
      execution: { ...runningPowerHold().execution, physicalState: 'off', desiredBinary: 'off' },
    }));
    expect(secondary).toMatchObject({ label: 'Off', reason: { text } });
  });

  it.each([
    ['its car draws', 3.2, 'on', 'plugged_in_charging', 'Running', 'Charging', '3.2 kW'],
    ['its car waits in the installation\'s queue', 0, 'on', 'plugged_in_paused', 'Idle', 'Waiting for current', '0.0 kW'],
    ['it is switched off', 0, 'off', 'plugged_in_paused', 'Off', 'Not charging', '0.0 kW'],
    ['its car has finished', 0, 'on', 'plugged_in_finished', 'Off', 'Not charging', '0.0 kW'],
    ['its car stopped itself', 0, 'on', 'plugged_in_car_stopped', 'Off', 'Not charging', '0.0 kW'],
    ['its car is unplugged', 0, 'on', 'plugged_out', 'Off', 'Unplugged', '0.0 kW'],
  ] as const)('shows a secondary\'s own state while %s', (_case, drawKw, physicalState, evChargingState, label, fact, power) => {
    const secondary = status(card({ role: 'secondary', mainName: 'Garage' }, {
      currentDrawKw: drawKw, evChargingState, reason: { code: PLAN_REASON_CODES.capacity, shortfallKw: 2 },
      hasPowerReading: false, execution: { ...runningPowerHold().execution, physicalState },
    }));
    expect(secondary).toMatchObject({ label, factText: fact, powerText: power, limited: false });
    expect(secondary.reason?.text).toBe('Its current is set through Garage. '
      + 'The chargers share the available current between the cars that are charging.');
  });
});
