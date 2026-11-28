import {
  resolveSetupPriorityFraming, setupPriorityDetail, setupPriorityTitle,
} from '../src/ui/setupPriorityStep.ts';

describe('setup priority step framing', () => {
  it('keeps the limit framing while a limit is in force or the limits are unread', () => {
    for (const limitsInForce of [true, null]) {
      for (const homeHasSolar of [true, false]) {
        expect(resolveSetupPriorityFraming(limitsInForce, homeHasSolar)).toBe('limit');
      }
    }
    expect(setupPriorityTitle('limit')).toBe('Choose what stays on longest');
    expect(setupPriorityDetail('limit', 'Home', 0)).toBe('Optional. In Home, the top device keeps running longest. '
      + 'Drag to change the order, or continue with the current order. You can change it later in Modes.');
  });

  it('frames the order as who gets spare solar first with no limit in a solar home', () => {
    expect(resolveSetupPriorityFraming(false, true)).toBe('solar');
    expect(setupPriorityTitle('solar')).toBe('Choose what gets spare solar first');
    expect(setupPriorityDetail('solar', 'Home', 2)).toBe('Optional. In Home, the top device gets spare solar first. '
      + 'Batteries higher in the list are also planned first. '
      + 'Drag to change the order, or continue with the current order. You can change it later in Modes.');
  });

  it('has nothing to frame with no limit and no solar, so setup skips the step', () => {
    expect(resolveSetupPriorityFraming(false, false)).toBe('none');
  });
});
