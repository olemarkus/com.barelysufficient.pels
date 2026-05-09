export const qs = (selector: string) => document.querySelector(selector) as HTMLElement;

export const toastEl = qs('#toast');
export const deviceList = qs('#device-list');
export const emptyState = qs('#empty-state');
export const refreshButton = document.querySelector('#refresh-button') as HTMLButtonElement;
export const powerList = qs('#power-list');
export const powerEmpty = qs('#power-empty');
export const powerWeekPrev = document.querySelector('#power-week-prev') as HTMLButtonElement;
export const powerWeekNext = document.querySelector('#power-week-next') as HTMLButtonElement;
export const powerWeekLabel = qs('#power-week-label');
export const dailyList = qs('#daily-list');
export const dailyEmpty = qs('#daily-empty');
export const usageToday = qs('#usage-today');
export const usageWeek = qs('#usage-week');
export const usageMonth = qs('#usage-month');
export const usageWeekdayAvg = qs('#usage-weekday-avg');
export const usageWeekendAvg = qs('#usage-weekend-avg');
export const hourlyPattern = qs('#hourly-pattern');
export const hourlyPatternMeta = qs('#hourly-pattern-meta');
export const usageDayTitle = qs('#usage-day-title');
export const usageDayLabel = qs('#usage-day-label');
export const usageDayStatusPill = qs('#usage-day-status-pill');
export const usageDayTotal = qs('#usage-day-total');
export const usageDayPeak = qs('#usage-day-peak');
export const usageDayOverCap = qs('#usage-day-over-cap');
export const usageDayChart = qs('#usage-day-chart');
export const usageDayBars = qs('#usage-day-bars');
export const usageDayLabels = qs('#usage-day-labels');
export const usageDayEmpty = qs('#usage-day-empty');
export const usageDayMeta = qs('#usage-day-meta');
export const legacyShellCopy = document.querySelector('#legacy-shell-copy') as HTMLElement | null;
export const legacyShellNav = document.querySelector('#legacy-shell-nav') as HTMLElement | null;
export const redesignShellNav = document.querySelector('#redesign-shell-nav') as HTMLElement | null;
export const tabs = Array.from(document.querySelectorAll<HTMLElement>('.tab'));
export const panels = Array.from(document.querySelectorAll<HTMLElement>('.panel'));
export const capacityForm = document.querySelector('#capacity-form') as HTMLFormElement;
export const capacityLimitInput = document.querySelector('#capacity-limit') as HTMLInputElement;
export const capacityMarginInput = document.querySelector('#capacity-margin') as HTMLInputElement;
export const capacityDryRunInput = document.querySelector('#capacity-dry-run') as HTMLInputElement;
export const powerSourceSelect = document.querySelector('#power-source') as HTMLSelectElement;
export const settingsLimitsForm = document.querySelector('#settings-limits-form') as HTMLFormElement | null;
export const settingsCapacityLimitInput = document.querySelector('#settings-capacity-limit') as HTMLInputElement | null;
export const settingsCapacityMarginInput = document.querySelector(
  '#settings-capacity-margin',
) as HTMLInputElement | null;
export const settingsCapacityReactionHint = document.querySelector('#settings-capacity-reaction') as HTMLElement | null;
export const settingsPowerSourceSelect = document.querySelector('#settings-power-source') as HTMLSelectElement | null;
export const settingsSimulationModeInput = document.querySelector(
  '#settings-simulation-mode',
) as HTMLInputElement | null;
export const dailyBudgetForm = document.querySelector('#daily-budget-form') as HTMLFormElement;
export const dailyBudgetEnabledInput = document.querySelector('#daily-budget-enabled') as HTMLInputElement;
export const dailyBudgetKwhInput = document.querySelector('#daily-budget-kwh') as HTMLInputElement;
export const dailyBudgetPriceShapingInput = document.querySelector('#daily-budget-price-shaping') as HTMLInputElement;
export const dailyBudgetAdvancedForm = document.querySelector('#daily-budget-advanced-form') as HTMLFormElement;
export const dailyBudgetControlledWeightInput = document.querySelector(
  '#daily-budget-controlled-weight',
) as HTMLSelectElement;
export const dailyBudgetPriceFlexShareInput = document.querySelector(
  '#daily-budget-price-flex-share',
) as HTMLSelectElement;
export const dailyBudgetStatusPill = qs('#daily-budget-status-pill');
export const dailyBudgetTitle = qs('#daily-budget-title');
export const dailyBudgetDay = qs('#daily-budget-day');
export const dailyBudgetRemaining = qs('#daily-budget-remaining');
export const dailyBudgetDeviation = qs('#daily-budget-deviation');
export const dailyBudgetCostLabel = qs('#daily-budget-cost-label');
export const dailyBudgetCost = qs('#daily-budget-cost');
export const dailyBudgetChart = qs('#daily-budget-chart');
export const dailyBudgetBars = qs('#daily-budget-bars');
export const dailyBudgetLabels = qs('#daily-budget-labels');
export const dailyBudgetEmpty = qs('#daily-budget-empty');
export const dailyBudgetConfidence = document.getElementById('daily-budget-confidence') as HTMLElement | null;
export const dailyBudgetAllocationWarning = document.getElementById(
  'daily-budget-allocation-warning',
) as HTMLElement | null;
export const dailyBudgetBreakdownInput = document.querySelector('#daily-budget-breakdown') as HTMLInputElement;
export const dailyBudgetRecomputeButton = document.querySelector('#daily-budget-recompute') as HTMLButtonElement;
export const dailyBudgetApplyButton = document.querySelector('#daily-budget-apply') as HTMLButtonElement;
export const dailyBudgetDiscardButton = document.querySelector('#daily-budget-discard') as HTMLButtonElement;
export const dryRunBanner = qs('#dry-run-banner');
export const simulationDisableButton = document.querySelector('#simulation-disable-button') as HTMLButtonElement | null;
export const staleDataBanner = qs('#stale-data-banner');
export const staleDataBannerText = qs('#stale-data-text');
export const planLegacySurface = document.querySelector('#plan-legacy-surface') as HTMLElement | null;
export const planRedesignSurface = document.querySelector('#plan-redesign-surface') as HTMLElement | null;
export const planMeta = qs('#plan-meta');
export const planList = qs('#plan-list');
export const planHero = qs('#plan-hero');
export const planHourStrip = qs('#plan-hour-strip');
export const planCards = qs('#plan-cards');
export const planEmpty = qs('#plan-empty');
export const resetStatsButton = document.querySelector('#reset-stats-button') as HTMLButtonElement;
export const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
export const modeNewInput = document.querySelector('#mode-new') as HTMLInputElement;
export const addModeButton = document.querySelector('#add-mode-button') as HTMLButtonElement;
export const deleteModeButton = document.querySelector('#delete-mode-button') as HTMLButtonElement;
export const renameModeButton = document.querySelector('#rename-mode-button') as HTMLButtonElement;
export const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;
export const priorityForm = document.querySelector('#priority-form') as HTMLFormElement;
export const priorityList = qs('#priority-list');
export const priorityEmpty = qs('#priority-empty');

export const electricityPricesSurface = document.querySelector('#electricity-prices-surface') as HTMLElement;
export const priceAwareDevicesSurface = document.querySelector('#price-aware-devices-surface') as HTMLElement;
export const advancedOverviewRedesignRow = document.querySelector(
  '#advanced-overview-redesign-row',
) as HTMLElement | null;
export const advancedOverviewRedesignEnabledInput = document.querySelector(
  '#advanced-overview-redesign-enabled',
) as HTMLInputElement | null;
export const advancedEvSupportEnabledInput = document.querySelector('#advanced-ev-support-enabled') as HTMLInputElement;
export const advancedDeviceSelect = document.querySelector('#advanced-device-select') as HTMLSelectElement;
export const advancedDeviceClearButton = document.querySelector('#advanced-device-clear') as HTMLButtonElement;
export const advancedDeviceClearUnknownButton = document.querySelector(
  '#advanced-device-clear-unknown',
) as HTMLButtonElement;
export const advancedApiDeviceSelect = document.querySelector('#advanced-api-device-select') as HTMLSelectElement;
export const advancedApiDeviceRefreshButton = document.querySelector(
  '#advanced-api-device-refresh',
) as HTMLButtonElement;
export const advancedApiDeviceLogButton = document.querySelector('#advanced-api-device-log') as HTMLButtonElement;

export const deviceDetailOverlay = qs('#device-detail-overlay');
export const deviceDetailPanel = qs('#device-detail-panel');
export const deviceDetailTitle = qs('#device-detail-title');
export const deviceDetailClose = qs('#device-detail-close') as HTMLButtonElement;
export const deviceDetailNativeWiringRow = qs('#device-detail-native-wiring-row');
export const deviceDetailNativeWiring = document.querySelector('#device-detail-native-wiring') as HTMLInputElement;
export const deviceDetailNativeWiringConfirmRow = qs('#device-detail-native-wiring-confirm-row');
export const deviceDetailNativeWiringConfirm = document.querySelector(
  '#device-detail-native-wiring-confirm',
) as HTMLInputElement;
export const deviceDetailManaged = document.querySelector('#device-detail-managed') as HTMLInputElement;
export const deviceDetailControllable = document.querySelector('#device-detail-controllable') as HTMLInputElement;
export const deviceDetailPriceOpt = document.querySelector('#device-detail-price-opt') as HTMLInputElement;
export const deviceDetailBudgetExempt = document.querySelector('#device-detail-budget-exempt') as HTMLInputElement;
export const deviceDetailSocRow = qs('#device-detail-soc-row');
export const deviceDetailSocValue = qs('#device-detail-soc-value');
export const deviceDetailSocUpdated = qs('#device-detail-soc-updated');
export const deviceDetailControlModelRow = qs('#device-detail-control-model-row');
export const deviceDetailControlModel = document.querySelector('#device-detail-control-model') as HTMLSelectElement;
export const deviceDetailModes = qs('#device-detail-modes');
export const deviceDetailDeltaSection = qs('#device-detail-delta-section');
export const deviceDetailCheapDelta = document.querySelector('#device-detail-cheap-delta') as HTMLInputElement;
export const deviceDetailExpensiveDelta = document.querySelector('#device-detail-expensive-delta') as HTMLInputElement;
export const deviceDetailShedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
export const deviceDetailShedTempRow = qs('#device-detail-overshoot-temp-row');
export const deviceDetailShedTemp = document.querySelector('#device-detail-overshoot-temp') as HTMLInputElement;
export const deviceDetailShedStepRow = qs('#device-detail-overshoot-step-row');
export const deviceDetailShedStep = document.querySelector('#device-detail-overshoot-step') as HTMLSelectElement;
export const deviceDetailSteppedSection = qs('#device-detail-stepped-section');
export const deviceDetailSteppedSteps = qs('#device-detail-stepped-steps');
export const deviceDetailTargetPowerConfig = qs('#device-detail-target-power-config');
export const deviceDetailTargetPowerFields = qs('#device-detail-target-power-fields');
export const deviceDetailTargetPowerMin = document.querySelector('#device-detail-target-power-min') as HTMLInputElement;
export const deviceDetailTargetPowerMax = document.querySelector('#device-detail-target-power-max') as HTMLInputElement;
export const deviceDetailTargetPowerStep = document.querySelector(
  '#device-detail-target-power-step',
) as HTMLInputElement;
export const deviceDetailTargetPowerExcludeMin = document.querySelector(
  '#device-detail-target-power-exclude-min',
) as HTMLInputElement;
export const deviceDetailTargetPowerExcludeMax = document.querySelector(
  '#device-detail-target-power-exclude-max',
) as HTMLInputElement;
export const deviceDetailTargetPowerSave = document.querySelector(
  '#device-detail-target-power-save',
) as HTMLButtonElement;
export const deviceDetailTargetPowerClear = document.querySelector(
  '#device-detail-target-power-clear',
) as HTMLButtonElement;
export const deviceDetailTemperatureBoost = qs('#device-detail-temperature-boost');
export const deviceDetailTemperatureBoostEnabled = document.querySelector(
  '#device-detail-temperature-boost-enabled',
) as HTMLInputElement;
export const deviceDetailTemperatureBoostBelowRow = qs('#device-detail-temperature-boost-below-row');
export const deviceDetailTemperatureBoostBelow = document.querySelector(
  '#device-detail-temperature-boost-below',
) as HTMLInputElement;
export const deviceDetailEvBoost = qs('#device-detail-ev-boost');
export const deviceDetailEvBoostEnabled = document.querySelector(
  '#device-detail-ev-boost-enabled',
) as HTMLInputElement;
export const deviceDetailEvBoostBelowRow = qs('#device-detail-ev-boost-below-row');
export const deviceDetailEvBoostBelow = document.querySelector(
  '#device-detail-ev-boost-below',
) as HTMLInputElement;
export const deviceDetailEvBoostStatus = qs('#device-detail-ev-boost-status');
export const deviceDetailDeadlineObjectiveMount = document.querySelector(
  '#device-detail-deadline-objective',
) as HTMLElement | null;
export const deviceDetailSteppedAddStep = document.querySelector(
  '#device-detail-stepped-add-step',
) as HTMLButtonElement;
export const deviceDetailSteppedSave = document.querySelector(
  '#device-detail-stepped-save',
) as HTMLButtonElement;
export const deviceDetailSteppedReset = document.querySelector(
  '#device-detail-stepped-reset',
) as HTMLButtonElement;
export const deviceDetailDiagnosticsDisclosure = document.querySelector(
  '#device-detail-diagnostics-disclosure',
) as HTMLDetailsElement | null;
export const deviceDetailDiagnosticsStatus = qs('#device-detail-diagnostics-status');
export const deviceDetailDiagnosticsCards = qs('#device-detail-diagnostics-cards');
