import { buildDeviceStatus, type DeviceStatusInput } from '../../lib/plan/deviceStatusReadModel';
import { PLAN_REASON_CODES, type DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';

const runningPowerHold = (overrides: Partial<DeviceStatusInput> = {}): DeviceStatusInput => ({
  currentState: 'on', plannedState: 'shed', binaryControllable: true, isEvCharger: false,
  currentDrawKw: 1.2, expectedPowerKw: 1.5, controllable: true, available: true,
  reason: { code: PLAN_REASON_CODES.capacity, shortfallKw: 2.3 },
  priceTargetShift: { kind: 'none' }, adapterUnavailableStatus: undefined, builtInControlHeldByFlow: false, targetPowerControlRefused: false,
  standingCommandGrant: true, hasPowerReading: true,
  carIdentificationState: 'not_waiting',
  execution: {
    available: true, physicalState: 'on', observedStepId: null,
    desiredBinary: 'off', desiredStepId: null, binaryProgress: 'unmet',
    stepProgress: 'undriven', targetProgress: 'undriven', resumeExpected: false,
    steppedTransitionPending: false, stepCommandUnanswered: false, externalOffHeld: false,
  },
  ...overrides,
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
        factText: `50.0 °C · target 55 °C → ${target} °C`,
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
    expect(status.factText).toBe(`20.0 °C · target 21 °C → ${temperature.plannedTarget} °C`);
  });

  it('formats an arithmetic temperature target consistently in the fact and preview', () => {
    const device = runningPowerHold();
    const status = buildDeviceStatus({ ...device,
      temperature: { currentTemperature: 20, currentTarget: 21, plannedTarget: 15.499999999999998,
        thermalDirection: 'heating' },
      execution: { ...device.execution, desiredBinary: null, targetProgress: 'unmet' },
    }, true, 0);
    expect(status.factText).toBe('20.0 °C · target 21 °C → 15.5 °C');
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

  const steppedHold = (): DeviceStatusInput => {
    const device = runningPowerHold();
    return { ...device, steppedLoad: {
      profile: { steps: [
        { id: 'off', planningPowerW: 0 }, { id: '6a', planningPowerW: 1380 }, { id: '16a', planningPowerW: 3680 },
      ] },
      reportedStepId: '16a', targetStepId: '6a', selectedStepId: '16a', planningPowerKw: 3.68, commandPending: false,
    }, execution: { ...device.execution,
      desiredBinary: 'on', binaryProgress: 'settled', observedStepId: '16a', desiredStepId: '6a', stepProgress: 'unmet',
    } };
  };

  it('names the decided level without claiming the real charger has reduced its draw', () => {
    const status = buildDeviceStatus(steppedHold(), true, 0);
    expect(status.label).toBe('Running');
    expect(status.reason).toEqual({ text: 'Would set level to 6 A (simulation)' });
  });

  it('keeps a stepped thermostat target consistent with its simulated target command', () => {
    const device = steppedHold();
    const status = buildDeviceStatus({ ...device,
      temperature: { currentTemperature: 50, currentTarget: 60, plannedTarget: 55.5, thermalDirection: 'heating' },
      execution: { ...device.execution, desiredStepId: '16a', stepProgress: 'settled', targetProgress: 'unmet' },
    }, true, 0);
    expect(status.factText).toBe('50.0 °C · target 55.5 °C');
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
    expect(status.factText).toBe('20.0 °C · target 21 °C');
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

  it('keeps the fairness explanation when a power reason also carries a decided level', () => {
    const status = buildDeviceStatus({ ...steppedHold(),
      steppedFairnessHold: { stepId: '6a', limitedDeviceCount: 2 },
    }, true, 0);
    expect(status.reason?.text).toMatch(/^Would be holding at 6 A — /u);
    expect(status.reason?.text).not.toContain('Would set level');
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
      execution: { ...device.execution, physicalState: 'off', binaryProgress: 'settled' },
    }, dryRun, 0);
    expect(status).toMatchObject({
      powerText: dryRun ? '0.4 kW' : 'Reported 0.4 kW', powerVariant: dryRun ? 'live' : 'reported',
    });
    expect(status.reason?.text).not.toContain('Would turn off');
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
    expect(kept().reason).toEqual({ text: 'PELS can only turn it on and off: its app does not accept level control' });
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
