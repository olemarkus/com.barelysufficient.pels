import { describe, expect, it } from 'vitest';
import { buildModeEnumValues } from '../../drivers/pels_insights/modeEnum';

describe('buildModeEnumValues', () => {
  it('returns the active mode first when no configured modes are supplied', () => {
    expect(buildModeEnumValues('Home', [])).toEqual([
      { id: 'Home', title: { en: 'Home' } },
    ]);
  });

  it('lists configured modes after the active mode and dedupes exact matches', () => {
    const values = buildModeEnumValues('Home', ['Home', 'Away', 'Night']);
    expect(values).toEqual([
      { id: 'Home', title: { en: 'Home' } },
      { id: 'Away', title: { en: 'Away' } },
      { id: 'Night', title: { en: 'Night' } },
    ]);
  });

  it('falls back to the first configured mode when active mode is empty', () => {
    // Prevents inventing a lowercase 'home' that would collide with a
    // user-configured 'Home' (priorities/targets are case-sensitive keys).
    expect(buildModeEnumValues('', ['Home', 'Away'])).toEqual([
      { id: 'Home', title: { en: 'Home' } },
      { id: 'Away', title: { en: 'Away' } },
    ]);
  });

  it('falls back to "Home" when both active mode and configured modes are empty', () => {
    expect(buildModeEnumValues('', [])).toEqual([
      { id: 'Home', title: { en: 'Home' } },
    ]);
  });

  it('ignores blank entries in configured modes', () => {
    const values = buildModeEnumValues('Home', ['', '   ', 'Away']);
    expect(values).toEqual([
      { id: 'Home', title: { en: 'Home' } },
      { id: 'Away', title: { en: 'Away' } },
    ]);
  });

  it('trims whitespace from active mode and configured modes', () => {
    const values = buildModeEnumValues('  Home  ', ['  Away  ', 'Night']);
    expect(values).toEqual([
      { id: 'Home', title: { en: 'Home' } },
      { id: 'Away', title: { en: 'Away' } },
      { id: 'Night', title: { en: 'Night' } },
    ]);
  });
});
