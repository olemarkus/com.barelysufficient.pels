/** The billing window whose average import power the hard cap protects. */
export type CapacityPeriodMinutes = 15 | 60;

/** The resolved capacity-control settings shared by runtime and settings UI. */
export type CapacitySettings = {
  limitKw: number;
  marginKw: number;
  periodMinutes: CapacityPeriodMinutes;
};

/**
 * One home's full capacity scalar block: the control settings plus the
 * dry-run flag that decides whether they actuate.
 */
export type CapacityScalarSettings = CapacitySettings & { dryRun: boolean };
