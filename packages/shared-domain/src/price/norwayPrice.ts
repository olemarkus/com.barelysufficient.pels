export const VAT_MULTIPLIER_STANDARD = 1.25;
export const VAT_MULTIPLIER_EXEMPT = 1;
export const NORGESPRIS_TARGET_EX_VAT = 40;

export const getVatMultiplier = (priceArea: string): number => (
  priceArea === 'NO4' ? VAT_MULTIPLIER_EXEMPT : VAT_MULTIPLIER_STANDARD
);

export const getNorgesprisTarget = (vatMultiplier: number): number => NORGESPRIS_TARGET_EX_VAT * vatMultiplier;
