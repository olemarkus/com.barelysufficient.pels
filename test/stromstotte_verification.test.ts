
import { calculateSubsidy, getVatMultiplier, SUBSIDY_COVERAGE_PERCENT, SUBSIDY_THRESHOLD_EX_VAT } from '../lib/price/norwegianTaxes';

describe('Electricity support verification (hvakosterstrommen.no logic)', () => {
    // Article logic: (Spot price ex VAT - threshold) * coverage * VAT
    // 2026 Parameters:
    // Threshold: 77 ore/kWh (ex VAT)
    // Coverage: 90% (0.90)

    const THRESHOLD_2026 = 77;
    const COVERAGE = 0.90;

    it('verifies constants match 2026 rules', () => {
        expect(SUBSIDY_THRESHOLD_EX_VAT).toBe(THRESHOLD_2026);
        expect(SUBSIDY_COVERAGE_PERCENT).toBe(COVERAGE);
    });

    it('calculates support correctly for high price example', () => {
        // Example: Spot price 100 ore (ex VAT)
        // Diff: 100 - 77 = 23 ore
        // Support (ex VAT): 23 * 0.90 = 20.7 ore
        // Support (inc VAT): 20.7 * 1.25 = 25.875 ore

        const spotPriceExVat = 100;
        const expectedSupportExVat = (spotPriceExVat - THRESHOLD_2026) * COVERAGE;

        const calculatedSupportExVat = calculateSubsidy(spotPriceExVat);

        expect(calculatedSupportExVat).toBeCloseTo(20.7, 4);
        expect(calculatedSupportExVat).toBe(expectedSupportExVat);
    });

    it('calculates support correctly for very high price example', () => {
        // Example: Spot price 200 ore (ex VAT)
        // Diff: 200 - 77 = 123 ore
        // Support (ex VAT): 123 * 0.90 = 110.7 ore

        const spotPriceExVat = 200;
        const calculatedSupportExVat = calculateSubsidy(spotPriceExVat);

        expect(calculatedSupportExVat).toBeCloseTo(110.7, 4);
    });

    it('returns 0 support when below threshold', () => {
        // Example: Spot price 70 ore (ex VAT)
        // Below 77, so 0 support
        expect(calculateSubsidy(70)).toBe(0);
        expect(calculateSubsidy(77)).toBe(0);
    });

  describe('Full Application Logic (simulated)', () => {
    it('applies VAT correctly to the support amount', () => {
            // In the app, we calculate support ex VAT, then multiply by VAT multiplier
            // effectively giving the user "VAT inclusive" support to deduct from their VAT inclusive bill.

            const spotPriceExVat = 100; // 125 inc VAT
            const supportExVat = calculateSubsidy(spotPriceExVat); // 20.7

            const vatMultiplier = getVatMultiplier('NO1'); // 1.25
            const supportIncVat = supportExVat * vatMultiplier; // 25.875

            expect(supportIncVat).toBeCloseTo(25.875, 4);
        });

        it('handles NO4 (Northern Norway) VAT exemption correctly', () => {
            // NO4: No VAT.
            // Spot price 100 (ex VAT) is also 100 (inc VAT) in practice.
            // Support: (100 - 77) * 0.90 = 20.7.
            // VAT Multiplier: 1.0.
            // Total Deducted: 20.7.

            const spotPriceExVat = 100;
            const supportExVat = calculateSubsidy(spotPriceExVat);
            const vatMultiplier = getVatMultiplier('NO4');
            const supportFinal = supportExVat * vatMultiplier;

      expect(vatMultiplier).toBe(1.0);
      expect(supportFinal).toBe(20.7);
    });
  });

  describe('User Provided Table Examples (Adapted for 2026)', () => {
    // The user provided an image showing examples with:
    // Threshold: 75 ore (2025 rate)
    // VAT: 25%
    // Coverage: 90%
    //
    // Our system uses 77 ore (2026 rate).
    // We verify that for the same INPUT spot prices, we get the correct OUTPUT for 2026 rules.

    it('Spot NOK 0.70 (below threshold)', () => {
      // Table: Spot 0.70 -> Support 0.00
      // 2026: 0.70 is 70 ore. Below 77. Support 0.
      const spotExVat = 70 / 1.25; // 56 ore
      expect(calculateSubsidy(spotExVat)).toBe(0);
    });

    it('Spot NOK 1.00 (calc check)', () => {
      // Input: Spot 100 ore incl VAT -> 80 ore ex VAT
      // Table (2025/75 ore): (80 - 75) * 0.9 * 1.25 = 5.625 ore (0.0563 NOK)
      // 2026 (77 ore): (80 - 77) * 0.9 = 2.7 ore ex VAT
      // Incl VAT: 2.7 * 1.25 = 3.375 ore (0.03375 NOK)

      const spotExVat = 80;
      const supportExVat = calculateSubsidy(spotExVat);
      const supportIncVat = supportExVat * 1.25;

      expect(supportExVat).toBeCloseTo(2.7, 4);
      expect(supportIncVat).toBeCloseTo(3.375, 4);
    });

    it('Spot NOK 1.50 (calc check)', () => {
      // Input: Spot 150 ore incl VAT -> 120 ore ex VAT
      // Table (2025/75 ore): (120 - 75) * 0.9 * 1.25 = 50.625 ore (0.5063 NOK)
      // 2026 (77 ore): (120 - 77) * 0.9 = 38.7 ore ex VAT
      // Incl VAT: 38.7 * 1.25 = 48.375 ore (0.4838 NOK)

      const spotExVat = 120;
      const supportExVat = calculateSubsidy(spotExVat);
      const supportIncVat = supportExVat * 1.25;

      expect(supportExVat).toBeCloseTo(38.7, 4);
      expect(supportIncVat).toBeCloseTo(48.375, 4);
    });

    it('Spot NOK 2.00 (calc check)', () => {
      // Input: Spot 200 ore incl VAT -> 160 ore ex VAT
      // Table (2025/75 ore): (160 - 75) * 0.9 * 1.25 = 95.625 ore (0.9563 NOK)
      // 2026 (77 ore): (160 - 77) * 0.9 = 74.7 ore ex VAT
      // Incl VAT: 74.7 * 1.25 = 93.375 ore (0.9338 NOK)

      const spotExVat = 160;
      const supportExVat = calculateSubsidy(spotExVat);
      const supportIncVat = supportExVat * 1.25;

      expect(supportExVat).toBeCloseTo(74.7, 4);
      expect(supportIncVat).toBeCloseTo(93.375, 4);
    });
  });
});
