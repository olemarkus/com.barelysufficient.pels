import { resolveUsageFooterText } from '../src/ui/homeScopeCopy.ts';

// The usage reset clears the Main home's history only. An area's Usage page must
// not point at it as if it were the area's own.
describe('resolveUsageFooterText', () => {
  it('points at the reset unqualified while the house has no meter areas', () => {
    expect(resolveUsageFooterText('main', false)).toBe(
      'Hourly data kept for 30 days, daily totals for 1 year. '
      + 'Reset usage history lives under Settings → Advanced → Data management.',
    );
  });

  it('names the Main home on the Main home once areas exist', () => {
    expect(resolveUsageFooterText('main', true)).toContain('Reset the Main home’s usage history under Settings');
  });

  it('says the reset is not an area’s own on that area’s page', () => {
    const text = resolveUsageFooterText('h_rental', true);
    expect(text).toContain('Resetting usage history covers the Main home only.');
    expect(text).not.toContain('Advanced');
  });
});
