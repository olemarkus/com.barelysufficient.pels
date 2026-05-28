import { materializeShedSnapshotFields } from '../lib/plan/planActionMaterialization';
import type { ShedActionIntent } from '../lib/device/deviceActionProjection';

describe('materializeShedSnapshotFields', () => {
  describe('turn_off intent', () => {
    const intent: ShedActionIntent = { kind: 'turn_off' };

    it('returns the turn_off triple regardless of shouldShed', () => {
      for (const shouldShed of [true, false]) {
        expect(materializeShedSnapshotFields({ intent, shouldShed })).toEqual({
          shedAction: 'turn_off',
          shedTemperature: null,
          releaseShedStepId: null,
        });
      }
    });
  });

  describe('set_temperature intent', () => {
    // PR A folds `controllable` into `resolveShedIntent`, so the producer never emits
    // `set_temperature` for a cap-off device. The materialiser only applies the per-cycle
    // `shouldShed` gate.
    const intent: ShedActionIntent = { kind: 'set_temperature', temperature: 17.5 };

    it('returns set_temperature with the producer-resolved temperature when shouldShed is true', () => {
      expect(materializeShedSnapshotFields({ intent, shouldShed: true })).toEqual({
        shedAction: 'set_temperature',
        shedTemperature: 17.5,
        releaseShedStepId: null,
      });
    });

    it('falls back to turn_off when shouldShed is false', () => {
      // Non-shedding cycle: the executor projection still needs a well-formed triple, but
      // the device's binary fallback is not actuated anyway. turn_off keeps the snapshot
      // shape valid.
      expect(materializeShedSnapshotFields({ intent, shouldShed: false })).toEqual({
        shedAction: 'turn_off',
        shedTemperature: null,
        releaseShedStepId: null,
      });
    });
  });

  describe('set_step intent', () => {
    // PR A: the producer emits set_step either for a cap-on stepped device configured for
    // set_step, or for any stepped device with no binary handle (cap-on or cap-off). Both
    // routes use the step capability. The producer-resolved release-cascade target step is
    // forwarded onto the snapshot triple as `releaseShedStepId`.
    it('returns set_step with the producer-resolved targetStepId regardless of shouldShed', () => {
      const intent: ShedActionIntent = { kind: 'set_step', targetStepId: 'low' };
      for (const shouldShed of [true, false]) {
        expect(materializeShedSnapshotFields({ intent, shouldShed })).toEqual({
          shedAction: 'set_step',
          shedTemperature: null,
          releaseShedStepId: 'low',
        });
      }
    });

    it('forwards a null targetStepId (degenerate empty profile) onto the triple', () => {
      const intent: ShedActionIntent = { kind: 'set_step', targetStepId: null };
      expect(materializeShedSnapshotFields({ intent, shouldShed: true })).toEqual({
        shedAction: 'set_step',
        shedTemperature: null,
        releaseShedStepId: null,
      });
    });
  });
});
