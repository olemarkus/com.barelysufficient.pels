/**
 * Norwegian Electricity Taxes and Fees
 *
 * This module handles calculation of Norwegian electricity taxes:
 * - Consumption tax
 * - Enova fee
 * - Electricity support (government subsidy)
 * - VAT handling for different price areas
 */

/**
 * Enova fee rate in ore/kWh (excluding VAT)
 * 2026 rate: 1.0 ore/kWh
 */
export const ENOVA_FEE_EX_VAT = 1.0;

/**
 * Get consumption tax rate
 * Rates are in ore/kWh excluding VAT
 *
 * NOTE: Some areas in NO4 (Nord-Troms, Finnmark) are exempt.
 * However, we apply the standard rate by default to cover the majority.
 * Exempt users should use 'Spot Price Adjustment' setting to subtract this.
 */
export function getConsumptionTaxRate(): number {
    // 2026 rate: 4.18 ore/kWh (standard rate)
    return 4.18;
}

/**
 * Get VAT multiplier based on price area
 * NO4 zone (Northern Norway) is treated as VAT exempt (0%) in this implementation.
 * Note: Technically only Nord-Troms and Finnmark are exempt, but we apply it to the whole NO4 zone for simplicity.
 */
export function getVatMultiplier(priceArea: string): number {
    return priceArea === 'NO4' ? 1.0 : 1.25;
}

/**
 * Electricity support configuration
 */
export const SUBSIDY_THRESHOLD_EX_VAT = 77; // ore/kWh excluding VAT
export const SUBSIDY_COVERAGE_PERCENT = 0.90; // State covers 90%
// Backwards-compatible names used by existing tests and callers.
export const STROMSTOTTE_THRESHOLD_EKS_MVA = SUBSIDY_THRESHOLD_EX_VAT;
export const STROMSTOTTE_COVERAGE_PERCENT = SUBSIDY_COVERAGE_PERCENT;

/**
 * Calculate electricity support
 * Returns the support amount in ore/kWh (positive value = credit/reduction)
 *
 * Current rules: Threshold 77 ore/kWh (ex VAT), 90% coverage
 *
 * @param spotPriceExVat - Spot price in ore/kWh excluding VAT
 * @returns Support amount in ore/kWh (0 if price is below threshold)
 */
export function calculateSubsidy(spotPriceExVat: number): number {
    if (spotPriceExVat <= SUBSIDY_THRESHOLD_EX_VAT) return 0;
    return (spotPriceExVat - SUBSIDY_THRESHOLD_EX_VAT) * SUBSIDY_COVERAGE_PERCENT;
}

// Backwards-compatible function name used by existing tests and callers.
export function calculateStromstotte(spotPriceExVat: number): number {
    return calculateSubsidy(spotPriceExVat);
}

/**
 * Calculate all Norwegian electricity taxes and fees for a given hour
 *
 * @param params - Parameters for tax calculation
 * @returns Object with all tax/fee components in ore/kWh (including VAT where applicable)
 */
export function calculateNorwegianTaxes(params: {
    spotPriceExVat: number;
    priceArea: string;
}): {
    consumptionTax: number;
    enovaFee: number;
    subsidy: number;
    vatMultiplier: number;
} {
    const { spotPriceExVat, priceArea } = params;
    const vatMultiplier = getVatMultiplier(priceArea);

    // Calculate base rates (excluding VAT)
    const consumptionTaxExVat = getConsumptionTaxRate();
    const enovaFeeExVat = ENOVA_FEE_EX_VAT;

    // Subsidy is calculated on spot price ex. VAT, returned as credit amount
    const subsidyExVat = calculateSubsidy(spotPriceExVat);

    // Apply VAT to taxes (taxes include VAT in final price)
    return {
        consumptionTax: consumptionTaxExVat * vatMultiplier,
        enovaFee: enovaFeeExVat * vatMultiplier,
        subsidy: subsidyExVat * vatMultiplier, // Credit also scales with VAT
        vatMultiplier,
    };
}
