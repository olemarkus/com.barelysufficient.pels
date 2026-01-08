import {
  getConsumptionTaxRate,
  ENOVA_FEE_EX_VAT,
  calculateSubsidy,
  getVatMultiplier,
} from '../lib/price/norwegianTaxes';

describe('Norwegian Taxes (Current)', () => {
  describe('getConsumptionTaxRate', () => {
    it('returns standard rate 4.18 for all regions (including NO4)', () => {
      // Rate is now flat 4.18 regardless of season or region (default)
      expect(getConsumptionTaxRate()).toBe(4.18);
      // NO4 users must correct this manually if exempt
    });
  });

  describe('Enova Fee', () => {
    it('is 1.0', () => {
      expect(ENOVA_FEE_EX_VAT).toBe(1.0);
    });
  });

  describe('calculateSubsidy', () => {
    it('returns 0 if price is below threshold (77)', () => {
      expect(calculateSubsidy(76)).toBe(0);
      expect(calculateSubsidy(77)).toBe(0);
    });

    it('calculates 90% coverage above threshold (77)', () => {
      // Price 177, Threshold 77 -> Diff 100 -> 90% coverage = 90
      expect(calculateSubsidy(177)).toBe(90);
    });
  });

  describe('getVatMultiplier', () => {
    it('returns 1.0 for NO4', () => {
      expect(getVatMultiplier('NO4')).toBe(1.0);
    });

    it('returns 1.25 for other regions', () => {
      expect(getVatMultiplier('NO1')).toBe(1.25);
      expect(getVatMultiplier('NO2')).toBe(1.25);
      expect(getVatMultiplier('NO3')).toBe(1.25);
      expect(getVatMultiplier('NO5')).toBe(1.25);
    });
  });
});
