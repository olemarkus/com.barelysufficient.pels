import { getShedBehavior, normalizeShedBehaviors } from '../lib/utils/capacityHelpers';

describe('capacityHelpers', () => {
  it('preserves set_step shed behavior when no step id is configured', () => {
    const behaviors = normalizeShedBehaviors({
      'dev-1': { action: 'set_step' },
    });

    expect(behaviors).toEqual({
      'dev-1': { action: 'set_step' },
    });
    expect(getShedBehavior('dev-1', behaviors)).toEqual({
      action: 'set_step',
      temperature: null,
      stepId: null,
    });
  });

  it('drops legacy step ids for set_step during normalization', () => {
    const behaviors = normalizeShedBehaviors({
      'dev-1': { action: 'set_step', stepId: 'low' },
    });

    expect(behaviors).toEqual({
      'dev-1': { action: 'set_step' },
    });
  });
});
