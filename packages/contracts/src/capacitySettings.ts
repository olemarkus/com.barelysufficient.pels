/** The billing window whose average import power the hard cap protects. */
export type CapacityPeriodMinutes = 15 | 60;

/** The resolved capacity-control settings shared by runtime and settings UI. */
export type CapacitySettings = {
  limitKw: number;
  marginKw: number;
  periodMinutes: CapacityPeriodMinutes;
};

/** Independent live and settlement-period control settings, resolved by the power owner. */
export type PowerLimitSettings = CapacitySettings & {
  capacityEnabled: boolean;
  /** Signed net grid import is constrained when this is non-null. */
  gridImportLimitKw: number | null;
};

/**
 * Which hard cap live control holds: the configured one, or this month's
 * highest completed quarter once it is higher and the owner asked PELS to
 * follow it (`capacity_follow_month_peak`). Resolved by the power owner
 * (`lib/power/heldCapacityLimit.ts`).
 */
export type HardCapSource = 'configured' | 'month_peak';

/** How the home's connection is wired: this decides what a fuse size means in kW. */
export type MainFuseSupply = 'one_phase' | 'three_phase_neutral' | 'three_phase_no_neutral';

/** The owner's main fuse, resolved by the power owner. Main home only. */
export type MainFuse = { kind: 'off' } | { kind: 'on'; supply: MainFuseSupply; amps: number };

/** Which enabled power limit a ceiling comes from: the hard cap's capacity control, or grid import control. */
export type PowerLimitAxis = 'capacity' | 'grid';

/**
 * The lowest enabled power limit, in kW, and which limit it is. The power owner
 * resolves two readings of it (`lib/power/capacityModel.ts`): the planning
 * ceiling, on each limit's working rate (hard cap minus safety margin, grid
 * import target), and the configured ceiling, on the limits as configured. With
 * no power limit enabled there is no ceiling at all, never a stand-in rate.
 */
export type PowerLimitCeiling = {
  limit: PowerLimitAxis;
  kw: number;
};

/**
 * One home's full capacity scalar block: the control settings plus the
 * dry-run flag that decides whether they actuate, and the owner's switch for
 * holding the hard cap at this month's peak once it is higher
 * (`capacity_follow_month_peak`). The switch is not a control setting: live
 * control reads its effect through the held limits (`lib/power/heldCapacityLimit.ts`).
 */
export type CapacityScalarSettings = PowerLimitSettings & { dryRun: boolean; followMonthPeak: boolean };
