import { describe, expect, it } from 'vitest';
import { resolveHomeyPriceFormulaUiStatus } from '../../lib/price/homeyScheme';
import type { HomeyPriceResolution } from '../../lib/price/homeyScheme';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import { HOMEY_PRICE_FORMULA, PRICE_SCHEME } from '../../lib/utils/settingsKeys';

/**
 * A settings store where a key can be LISTED yet read back empty — the
 * transient miss this platform produces, and the one the status must not read
 * as a settled fact.
 */
const settingsWith = (
  values: Record<string, unknown>,
  unreadable: readonly string[] = [],
): SettingsPort => ({
  get: (key) => (unreadable.includes(key) ? undefined : values[key]),
  set: () => {},
  unset: () => {},
  getKeys: () => [...Object.keys(values), ...unreadable],
});

const resolution = (
  verdict: HomeyPriceResolution['verdict'],
  reasonCode: HomeyPriceResolution['reasonCode'],
): HomeyPriceResolution => ({ periods: [], verdict, reasonCode });

describe('resolveHomeyPriceFormulaUiStatus', () => {
  it('reports a working formula as applied', () => {
    const settings = settingsWith({
      [PRICE_SCHEME]: 'homey',
      [HOMEY_PRICE_FORMULA]: { mathExpression: '{{ (0.4 + [[price]]) * 1.25 }}' },
    });

    expect(resolveHomeyPriceFormulaUiStatus(settings, resolution('priced', 'formula_applied')))
      .toEqual({ kind: 'applied' });
  });

  it('reports a formula that compiles but prices nothing', () => {
    // `(price - 1) ^ 0.5` while every price is below 1: the expression is fine,
    // the series is empty, and "applied" would suppress the only explanation.
    const settings = settingsWith({
      [PRICE_SCHEME]: 'homey',
      [HOMEY_PRICE_FORMULA]: { mathExpression: '{{ ([[price]] - 1) ^ 0.5 }}' },
    });

    expect(resolveHomeyPriceFormulaUiStatus(settings, resolution('unpriceable', 'nothing_priced')))
      .toEqual({ kind: 'prices_nothing', expression: '{{ ([[price]] - 1) ^ 0.5 }}' });
  });

  it('does not read a transient scheme miss as another price source', () => {
    // Saying "none" here would blank the explanation on the very page the owner
    // opened because their prices are missing.
    const settings = settingsWith({
      [HOMEY_PRICE_FORMULA]: { mathExpression: '{{ sqrt([[price]]) }}' },
    }, [PRICE_SCHEME]);

    expect(resolveHomeyPriceFormulaUiStatus(settings, resolution('undecided', 'never_read')))
      .toEqual({ kind: 'unknown' });
  });

  it('reports nothing for a home priced from another source', () => {
    const settings = settingsWith({ [PRICE_SCHEME]: 'norway' });

    expect(resolveHomeyPriceFormulaUiStatus(settings, resolution('priced', 'no_formula')))
      .toEqual({ kind: 'none' });
  });

  it('reports an unreadable mirror as not read yet, not as working', () => {
    const settings = settingsWith({ [PRICE_SCHEME]: 'homey' }, [HOMEY_PRICE_FORMULA]);

    expect(resolveHomeyPriceFormulaUiStatus(settings, resolution('undecided', 'unreadable_mirror')))
      .toEqual({ kind: 'unknown' });
  });
});
