/**
 * Characterization net for the plan -> executable projection.
 *
 * This suite asserts nothing about whether the projection is RIGHT. It pins
 * exactly what it produces today, so the planner/executor seam train can move
 * the contract and the producer between layers and prove the output did not
 * change: a stage advertised as a pure move must show a ZERO diff here, and an
 * unexplained diff is the bug, found before it reaches a device.
 *
 * Explicit `toEqual` literals, NOT snapshots. The repo has no snapshot tests and
 * this net is the wrong place to introduce them: `vitest -u` regenerates
 * snapshots blanket, across whatever files the run touched, so the one keystroke
 * that makes a red net green again is always available — and a characterization
 * net that can be re-recorded on reflex protects nothing. A literal has to be
 * typed out, which is exactly the friction wanted here: when a stage legitimately
 * changes the shape (PR3 totalizes the axes; PR4 puts the shed end state on the
 * release intent), the author writes down what changed and says so in the PR
 * description.
 *
 * Corpus covers one case per axis the projection discriminates, including the
 * `release` axis, which the contract's own docblock records as having no
 * positive projection coverage — the axis PR3 totalizes.
 */
import { describe, expect, it } from 'vitest';
import {
  buildExecutableConvergenceDevice,
  buildExecutablePlan,
} from '../../lib/executor/executablePlanProjection';
import {
  buildBinaryDevice,
  buildPlan,
  buildSteppedDevice,
} from '../utils/planConvergenceFixtures';

describe('executable plan projection (characterization)', () => {
  it('projects a binary device the plan keeps', () => {
    expect(buildExecutablePlan(buildPlan([buildBinaryDevice()]))).toEqual({
      "devices": [
        {
          "binary": {
            "desiredOn": true,
            "deviceId": "dev-2",
            "name": "Heater",
            "source": "controlled",
          },
          "controllable": true,
          "id": "dev-2",
          "name": "Heater",
        },
      ],
    });
  });

  it('projects a binary device the plan sheds', () => {
    const plan = buildPlan([buildBinaryDevice({ plannedState: 'shed', plannedShedTargetKind: 'binary_off' })]);
    expect(buildExecutablePlan(plan)).toEqual({
      "devices": [
        {
          "binary": {
            "desiredOn": false,
            "deviceId": "dev-2",
            "name": "Heater",
            "source": "controlled",
          },
          "controllable": true,
          "id": "dev-2",
          "name": "Heater",
        },
      ],
    });
  });

  // A resume is `plannedState: 'keep'` on a device observed off — there is no
  // 'restore' member of PlannedDeviceState ('shed' | 'keep' | 'inactive'). It is
  // pinned on the CONVERGENCE view, not the intent: `buildExecutableBinaryIntent`
  // never reads `currentState`, so on the intent a resume is byte-identical to a
  // keep and a test asserting it there would pin nothing.
  it('projects the convergence view of a binary device the plan resumes', () => {
    expect(buildExecutableConvergenceDevice(
      buildBinaryDevice({ currentState: 'off', plannedState: 'keep' }),
    )).toEqual({
      "available": undefined,
      "desiredBinaryState": "on",
      "desiredStepId": undefined,
      "desiredTarget": null,
      "id": "dev-2",
      "observedBinaryOn": false,
      "observedState": "off",
      "observedStep": null,
      "observedTarget": null,
    });
  });

  // `deviceType: 'temperature'` is load-bearing, not decoration: `asOutputDevice`
  // runs `withTemperatureDiscriminant`, which STRIPS the temperature cluster from
  // any device that is not one (`isTemperatureControlDevice`). Without it the
  // target axis is silently absent and this case pins the same output as the
  // plain binary keep above.
  it('projects a temperature write', () => {
    const plan = buildPlan([buildBinaryDevice({
      deviceType: 'temperature', currentTarget: 18, plannedTarget: 21,
    })]);
    expect(buildExecutablePlan(plan)).toEqual({
      "devices": [
        {
          "binary": {
            "desiredOn": true,
            "deviceId": "dev-2",
            "name": "Heater",
            "source": "controlled",
          },
          "controllable": true,
          "id": "dev-2",
          "name": "Heater",
          "target": {
            "desired": 21,
            "deviceId": "dev-2",
            "name": "Heater",
            "purpose": "target_update",
            "recordRestoreOnTargetApply": undefined,
          },
        },
      ],
    });
  });

  it('projects a shed that lands on a setpoint', () => {
    const plan = buildPlan([buildBinaryDevice({
      deviceType: 'temperature',
      currentTarget: 21,
      plannedTarget: 16,
      plannedState: 'shed',
      plannedShedTargetKind: 'target_value',
    })]);
    expect(buildExecutablePlan(plan)).toEqual({
      "devices": [
        {
          "controllable": true,
          "id": "dev-2",
          "name": "Heater",
          "target": {
            "desired": 16,
            "deviceId": "dev-2",
            "name": "Heater",
            "purpose": "shed_temperature",
            "recordRestoreOnTargetApply": undefined,
          },
        },
      ],
    });
  });

  it('projects a stepped device held at its rung', () => {
    expect(buildExecutablePlan(buildPlan([buildSteppedDevice()]))).toEqual({
      "devices": [
        {
          "controllable": true,
          "id": "dev-1",
          "name": "Tank",
          "steppedLoad": {
            "confirmedCommandStepId": undefined,
            "controlAdapter": undefined,
            "desired": {
              "plannedStepId": "low",
              "stepId": "low",
            },
            "desiredOn": true,
            "id": "dev-1",
            "matchingCommandAttempt": null,
            "matchingRestoreAttempt": null,
            "name": "Tank",
            "nextStepCommandRetryAtMs": undefined,
            "plannedShedTarget": undefined,
            "previousStepId": "low",
            "stepCommandRetryCount": 0,
            "steppedLoadProfile": {
              "steps": [
                {
                  "id": "off",
                  "planningPowerW": 0,
                },
                {
                  "id": "low",
                  "planningPowerW": 1250,
                },
                {
                  "id": "max",
                  "planningPowerW": 3000,
                },
              ],
            },
            "transition": {
              "binaryTarget": null,
              "commandStepId": "low",
              "effectiveTransition": "steady",
              "plannedDesiredStepId": "low",
              "stepPreparationPurpose": null,
              "transitionPhase": "settled",
            },
          },
        },
      ],
    });
  });

  it('projects a stepped device shed to an intermediate rung', () => {
    const plan = buildPlan([buildSteppedDevice({
      plannedState: 'shed',
      plannedShedTargetKind: 'step',
      desiredStepId: 'off',
      plannedShedStepId: 'off',
    })]);
    expect(buildExecutablePlan(plan)).toEqual({
      "devices": [
        {
          "controllable": true,
          "id": "dev-1",
          "name": "Tank",
          "steppedLoad": {
            "confirmedCommandStepId": undefined,
            "controlAdapter": undefined,
            "desired": {
              "plannedStepId": "off",
              "stepId": "off",
            },
            "id": "dev-1",
            "matchingCommandAttempt": null,
            "matchingRestoreAttempt": null,
            "name": "Tank",
            "nextStepCommandRetryAtMs": undefined,
            "plannedShedTarget": {
              "kind": "step",
              "stepId": "off",
            },
            "previousStepId": "low",
            "stepCommandRetryCount": 0,
            "steppedLoadProfile": {
              "steps": [
                {
                  "id": "off",
                  "planningPowerW": 0,
                },
                {
                  "id": "low",
                  "planningPowerW": 1250,
                },
                {
                  "id": "max",
                  "planningPowerW": 3000,
                },
              ],
            },
            "transition": {
              "binaryTarget": null,
              "commandStepId": "off",
              "effectiveTransition": "step_down_while_on",
              "plannedDesiredStepId": "off",
              "stepPreparationPurpose": null,
              "transitionPhase": "settled",
            },
          },
        },
      ],
    });
  });

  it('projects a stepped device the plan resumes from off', () => {
    const plan = buildPlan([buildSteppedDevice({
      currentState: 'off',
      selectedStepId: 'off',
      plannedState: 'keep',
      desiredStepId: 'low',
    })]);
    expect(buildExecutablePlan(plan)).toEqual({
      "devices": [
        {
          "controllable": true,
          "id": "dev-1",
          "name": "Tank",
          "steppedLoad": {
            "confirmedCommandStepId": undefined,
            "controlAdapter": undefined,
            "desired": {
              "plannedStepId": "low",
              "stepId": "low",
            },
            "desiredOn": true,
            "id": "dev-1",
            "matchingCommandAttempt": null,
            "matchingRestoreAttempt": null,
            "name": "Tank",
            "nextStepCommandRetryAtMs": undefined,
            "plannedShedTarget": undefined,
            "previousStepId": "off",
            "stepCommandRetryCount": 0,
            "steppedLoadProfile": {
              "steps": [
                {
                  "id": "off",
                  "planningPowerW": 0,
                },
                {
                  "id": "low",
                  "planningPowerW": 1250,
                },
                {
                  "id": "max",
                  "planningPowerW": 3000,
                },
              ],
            },
            "transition": {
              "binaryTarget": true,
              "commandStepId": "low",
              "effectiveTransition": "restore_from_off_at_low",
              "plannedDesiredStepId": "low",
              "stepPreparationPurpose": "prepare_for_on",
              "transitionPhase": "step_preparation",
            },
          },
        },
      ],
    });
  });

  it('projects the release axis', () => {
    const plan = buildPlan([buildBinaryDevice({
      plannedState: 'keep',
      deferredReleaseIntent: 'shed_release',
    })]);
    expect(buildExecutablePlan(plan)).toEqual({
      "devices": [
        {
          "binary": {
            "desiredOn": true,
            "deviceId": "dev-2",
            "name": "Heater",
            "source": "controlled",
          },
          "controllable": true,
          "id": "dev-2",
          "name": "Heater",
          "release": {
            "deviceId": "dev-2",
            "kind": "shed_release",
            "name": "Heater",
            "releaseShedStepId": undefined,
          },
        },
      ],
    });
  });

  it('projects the convergence view of a stepped device', () => {
    expect(buildExecutableConvergenceDevice(buildSteppedDevice())).toEqual({
      "available": undefined,
      "desiredBinaryState": "on",
      "desiredStepId": "low",
      "desiredTarget": null,
      "id": "dev-1",
      "observedBinaryOn": true,
      "observedState": "on",
      "observedStep": {
        "reportedStepId": undefined,
        "selectedStepId": "low",
      },
      "observedTarget": null,
    });
  });

  it('projects the convergence view of a binary device with a planned setpoint', () => {
    expect(buildExecutableConvergenceDevice(buildBinaryDevice({
      deviceType: 'temperature', currentTarget: 18, plannedTarget: 21,
    }))).toEqual({
      "available": undefined,
      "desiredBinaryState": "on",
      "desiredStepId": undefined,
      "desiredTarget": 21,
      "id": "dev-2",
      "observedBinaryOn": true,
      "observedState": "on",
      "observedStep": null,
      "observedTarget": 18,
    });
  });
});
