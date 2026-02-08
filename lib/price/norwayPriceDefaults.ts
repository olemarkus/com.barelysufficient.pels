export const DEFAULT_NORGESPRIS_HOURLY_USAGE_ESTIMATE_KWH = 1;
export const NORGESPRIS_TARGET_EX_VAT = 40;
export const NORGESPRIS_HOUSEHOLD_MONTHLY_CAP_KWH = 5000;
export const NORGESPRIS_CABIN_MONTHLY_CAP_KWH = 1000;

const normalizeText = (value: string): string => value.toLowerCase().trim();

export const isCabinTariffGroup = (tariffGroup: string): boolean => {
  const normalized = normalizeText(tariffGroup);
  return normalized.includes('hytter')
    || normalized.includes('hytte')
    || normalized.includes('fritid')
    || normalized.includes('cabin')
    || normalized.includes('holiday');
};

export const getNorgesprisMonthlyCapForTariffGroup = (tariffGroup: string): number => (
  isCabinTariffGroup(tariffGroup)
    ? NORGESPRIS_CABIN_MONTHLY_CAP_KWH
    : NORGESPRIS_HOUSEHOLD_MONTHLY_CAP_KWH
);
