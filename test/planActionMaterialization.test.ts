import { materializeShedSnapshotFields } from '../lib/plan/planActionMaterialization';
import type { ShedActionIntent } from '../lib/device/deviceActionProjection';

describe('materializeShedSnapshotFields', () => {
  describe('turn_off intent', () => {
    const intent: ShedActionIntent = { kind: 'turn_off' };

    it('returns the turn_off triple regardless of cycle gates', () => {
      for (const controllable of [true, false]) {
        for (const shouldShed of [true, false]) {
          for (const hasBinaryControl of [true, false, undefined]) {
            expect(materializeShedSnapshotFields({
              intent, controllable, shouldShed, hasBinaryControl,
            })).toEqual({
              shedAction: 'turn_off',
              shedTemperature: null,
              shedStepId: null,
            });
          }
        }
      }
    });
  });

  describe('set_temperature intent', () => {
    const intent: ShedActionIntent = { kind: 'set_temperature', temperature: 17.5 };

    it('returns set_temperature with the producer-resolved temperature when controllable && shouldShed', () => {
      expect(materializeShedSnapshotFields({
        intent, controllable: true, shouldShed: true, hasBinaryControl: true,
      })).toEqual({
        shedAction: 'set_temperature',
        shedTemperature: 17.5,
        shedStepId: null,
      });
    });

    it('falls back to turn_off when controllable is false', () => {
      expect(materializeShedSnapshotFields({
        intent, controllable: false, shouldShed: true, hasBinaryControl: true,
      })).toEqual({
        shedAction: 'turn_off',
        shedTemperature: null,
        shedStepId: null,
      });
    });

    it('falls back to turn_off when shouldShed is false', () => {
      expect(materializeShedSnapshotFields({
        intent, controllable: true, shouldShed: false, hasBinaryControl: true,
      })).toEqual({
        shedAction: 'turn_off',
        shedTemperature: null,
        shedStepId: null,
      });
    });

    it('falls back to turn_off for cap-off + no binary control (set_temperature intent without gate match)', () => {
      // A cap-off thermostat-stepped without binary control still maps to turn_off here because
      // the intent kind is set_temperature, not set_step. The set_step path is reserved for
      // intents whose producer explicitly chose set_step (e.g. stepped no-binary-control).
      expect(materializeShedSnapshotFields({
        intent, controllable: false, shouldShed: true, hasBinaryControl: false,
      })).toEqual({
        shedAction: 'turn_off',
        shedTemperature: null,
        shedStepId: null,
      });
    });
  });

  describe('set_step intent', () => {
    const intent: ShedActionIntent = { kind: 'set_step' };

    it('returns set_step when controllable (cap-on stepped)', () => {
      expect(materializeShedSnapshotFields({
        intent, controllable: true, shouldShed: true, hasBinaryControl: true,
      })).toEqual({
        shedAction: 'set_step',
        shedTemperature: null,
        shedStepId: null,
      });
    });

    it('returns set_step for cap-off device with no binary control (no other handle)', () => {
      expect(materializeShedSnapshotFields({
        intent, controllable: false, shouldShed: true, hasBinaryControl: false,
      })).toEqual({
        shedAction: 'set_step',
        shedTemperature: null,
        shedStepId: null,
      });
    });

    it('falls back to turn_off for cap-off device with binary control', () => {
      expect(materializeShedSnapshotFields({
        intent, controllable: false, shouldShed: true, hasBinaryControl: true,
      })).toEqual({
        shedAction: 'turn_off',
        shedTemperature: null,
        shedStepId: null,
      });
    });

    it('falls back to turn_off for cap-off device with undefined hasBinaryControl', () => {
      // hasBinaryControl=undefined defaults conservatively to "device has binary control" since
      // the legacy `resolveSteppedShedAction` only fired the no-binary fallback on an explicit
      // `=== false`. This matches that behaviour.
      expect(materializeShedSnapshotFields({
        intent, controllable: false, shouldShed: true, hasBinaryControl: undefined,
      })).toEqual({
        shedAction: 'turn_off',
        shedTemperature: null,
        shedStepId: null,
      });
    });

    it('returns set_step when controllable even with undefined hasBinaryControl', () => {
      expect(materializeShedSnapshotFields({
        intent, controllable: true, shouldShed: false, hasBinaryControl: undefined,
      })).toEqual({
        shedAction: 'set_step',
        shedTemperature: null,
        shedStepId: null,
      });
    });
  });
});
