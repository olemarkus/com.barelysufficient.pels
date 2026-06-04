import { priceRateLabelToAmountUnit } from '../../packages/shared-domain/src/price/priceUnitLabel';

describe('priceRateLabelToAmountUnit', () => {
  it('strips a trailing /kWh from a Nordpool rate label', () => {
    expect(priceRateLabelToAmountUnit('øre/kWh')).toBe('øre');
  });

  it('strips a trailing /kWh from a kr rate label', () => {
    expect(priceRateLabelToAmountUnit('kr/kWh')).toBe('kr');
  });

  it('tolerates surrounding whitespace and case in the /kWh suffix', () => {
    expect(priceRateLabelToAmountUnit('EUR / KWH')).toBe('EUR');
    expect(priceRateLabelToAmountUnit('  NOK/kWh  ')).toBe('NOK');
  });

  it('returns amount-shaped labels (bare currency / neutral fallback) unchanged', () => {
    expect(priceRateLabelToAmountUnit('NOK')).toBe('NOK');
    expect(priceRateLabelToAmountUnit('price units')).toBe('price units');
  });

  it('never returns a per-kWh rate', () => {
    for (const label of ['øre/kWh', 'kr/kWh', 'NOK/kWh', 'NOK', 'price units']) {
      expect(priceRateLabelToAmountUnit(label)).not.toMatch(/\/kwh/i);
    }
  });

  it('falls back to the trimmed input when stripping would leave nothing', () => {
    expect(priceRateLabelToAmountUnit('/kWh')).toBe('/kWh');
    expect(priceRateLabelToAmountUnit('  /kWh  ')).toBe('/kWh');
  });
});
