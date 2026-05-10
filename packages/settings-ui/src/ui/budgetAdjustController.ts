import type {
  DailyBudgetModelPreviewResponse,
  DailyBudgetModelSettings,
  DailyBudgetUiPayload,
} from '../../../contracts/src/dailyBudgetTypes.ts';
import {
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
} from '../../../contracts/src/settingsKeys.ts';
import {
  SETTINGS_UI_APPLY_DAILY_BUDGET_MODEL_PATH,
  SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  MAX_DAILY_BUDGET_KWH,
  MIN_DAILY_BUDGET_KWH,
  PRICE_FLEX_HIGH,
  PRICE_FLEX_HIGH_THRESHOLD,
  PRICE_FLEX_LOW,
  PRICE_FLEX_MEDIUM,
  PRICE_SHAPING_FLEX_SHARE,
  UNMANAGED_RESERVE_BALANCED_MODE,
  UNMANAGED_RESERVE_CONSERVATIVE_MODE,
  UNMANAGED_RESERVE_MODE,
} from '../../../contracts/src/dailyBudgetConstants.ts';
import { callApi, getSetting, getSettingFresh } from './homey.ts';
import { showToast, showToastError } from './toast.ts';
import { logSettingsError } from './logging.ts';

export type BudgetAdjustStatus = 'clean' | 'dirty' | 'pending';

export type BudgetAdjustDraft = {
  enabled: boolean;
  dailyBudgetKWh: number;
  priceShaping: boolean;
  controlledWeight: number;
  priceFlexShare: number;
};

const RESERVE_VALUES = new Set([UNMANAGED_RESERVE_BALANCED_MODE, UNMANAGED_RESERVE_CONSERVATIVE_MODE]);
const FLEX_VALUES = new Set([PRICE_FLEX_LOW, PRICE_FLEX_MEDIUM, PRICE_FLEX_HIGH]);

const parseNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const parseFlexible = (value: unknown, fallback: number): number => parseNumber(value) ?? fallback;

const parseFlexibleBool = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  if (typeof value === 'number') return value !== 0;
  return fallback;
};

const clampKWh = (value: number): number => (
  Math.min(MAX_DAILY_BUDGET_KWH, Math.max(MIN_DAILY_BUDGET_KWH, value))
);

const normaliseReserve = (value: unknown): number => {
  const parsed = parseNumber(value);
  if (parsed === null) return UNMANAGED_RESERVE_MODE;
  if (RESERVE_VALUES.has(parsed)) return parsed;
  return parsed >= 0.5 ? UNMANAGED_RESERVE_CONSERVATIVE_MODE : UNMANAGED_RESERVE_BALANCED_MODE;
};

const normaliseFlex = (value: unknown): number => {
  const parsed = parseNumber(value);
  if (parsed === null) return PRICE_SHAPING_FLEX_SHARE;
  if (FLEX_VALUES.has(parsed)) return parsed;
  if (parsed <= PRICE_FLEX_LOW) return PRICE_FLEX_LOW;
  if (parsed >= PRICE_FLEX_HIGH_THRESHOLD) return PRICE_FLEX_HIGH;
  return PRICE_FLEX_MEDIUM;
};

const defaultDraft = (): BudgetAdjustDraft => ({
  enabled: false,
  dailyBudgetKWh: MIN_DAILY_BUDGET_KWH,
  priceShaping: true,
  controlledWeight: UNMANAGED_RESERVE_MODE,
  priceFlexShare: PRICE_SHAPING_FLEX_SHARE,
});

let activeDraft: BudgetAdjustDraft = defaultDraft();
let workingDraft: BudgetAdjustDraft = defaultDraft();
let status: BudgetAdjustStatus = 'clean';
let pendingPreview: DailyBudgetModelPreviewResponse | null = null;
let busy = false;
let draftRevision = 0;
let renderRequested: () => void = () => {};
type RefreshArgs = { payload?: DailyBudgetUiPayload | null; appliedSettings?: DailyBudgetModelSettings };
let refreshActivePlan: (args?: RefreshArgs) => Promise<void> = async () => {};

export const setBudgetAdjustRenderer = (render: () => void): void => {
  renderRequested = render;
};

export const setBudgetAdjustRefresh = (
  refresh: (args?: RefreshArgs) => Promise<void>,
): void => {
  refreshActivePlan = refresh;
};

const draftsEqual = (a: BudgetAdjustDraft, b: BudgetAdjustDraft): boolean => (
  a.enabled === b.enabled
  && a.dailyBudgetKWh === b.dailyBudgetKWh
  && a.priceShaping === b.priceShaping
  && a.controlledWeight === b.controlledWeight
  && a.priceFlexShare === b.priceFlexShare
);

const toModelSettings = (draft: BudgetAdjustDraft): DailyBudgetModelSettings => ({
  enabled: draft.enabled,
  dailyBudgetKWh: clampKWh(draft.dailyBudgetKWh),
  priceShapingEnabled: draft.priceShaping,
  controlledUsageWeight: draft.controlledWeight,
  priceShapingFlexShare: draft.priceFlexShare,
});

const fromModelSettings = (settings: DailyBudgetModelSettings): BudgetAdjustDraft => ({
  enabled: Boolean(settings.enabled),
  dailyBudgetKWh: clampKWh(Number(settings.dailyBudgetKWh)),
  priceShaping: Boolean(settings.priceShapingEnabled),
  controlledWeight: normaliseReserve(settings.controlledUsageWeight),
  priceFlexShare: normaliseFlex(settings.priceShapingFlexShare),
});

const readDraftFromSettings = async (fresh = false): Promise<BudgetAdjustDraft> => {
  const read = fresh ? getSettingFresh : getSetting;
  const [enabled, dailyBudgetKWh, priceShaping, controlledWeightRaw, priceFlexRaw] = await Promise.all([
    read(DAILY_BUDGET_ENABLED),
    read(DAILY_BUDGET_KWH),
    read(DAILY_BUDGET_PRICE_SHAPING_ENABLED),
    read(DAILY_BUDGET_CONTROLLED_WEIGHT),
    read(DAILY_BUDGET_PRICE_FLEX_SHARE),
  ]);
  return {
    enabled: parseFlexibleBool(enabled, false),
    dailyBudgetKWh: clampKWh(parseFlexible(dailyBudgetKWh, MIN_DAILY_BUDGET_KWH)),
    priceShaping: parseFlexibleBool(priceShaping, true),
    controlledWeight: normaliseReserve(controlledWeightRaw),
    priceFlexShare: normaliseFlex(priceFlexRaw),
  };
};

export const loadBudgetAdjust = async (options?: { fresh?: boolean }): Promise<void> => {
  const next = await readDraftFromSettings(options?.fresh ?? false);
  activeDraft = next;
  workingDraft = next;
  status = 'clean';
  pendingPreview = null;
  busy = false;
  // Any in-flight preview/apply must be considered stale after a fresh load.
  draftRevision += 1;
  renderRequested();
};

export const refreshBudgetAdjust = async (): Promise<void> => {
  const next = await readDraftFromSettings(true);
  const wasClean = status === 'clean' && !pendingPreview;
  activeDraft = next;
  // Any pending preview was computed against the prior active baseline; once
  // an external update lands, the candidate is no longer trustworthy.
  pendingPreview = null;
  // Invalidate any in-flight preview snapshot so it cannot resurrect the
  // candidate against the new baseline.
  draftRevision += 1;
  if (wasClean) {
    workingDraft = next;
    status = 'clean';
  } else {
    status = draftsEqual(workingDraft, activeDraft) ? 'clean' : 'dirty';
  }
  renderRequested();
};

export const getBudgetAdjustView = (): {
  draft: BudgetAdjustDraft;
  active: BudgetAdjustDraft;
  candidate: BudgetAdjustDraft | null;
  status: BudgetAdjustStatus;
  busy: boolean;
} => ({
  draft: workingDraft,
  active: activeDraft,
  candidate: pendingPreview ? fromModelSettings(pendingPreview.settings) : null,
  status,
  busy,
});

export const getBudgetAdjustCandidatePayload = (): DailyBudgetUiPayload | null => (
  pendingPreview?.candidate ?? null
);

export const updateBudgetAdjustField = (patch: Partial<BudgetAdjustDraft>): void => {
  const next: BudgetAdjustDraft = { ...workingDraft, ...patch };
  if (Number.isFinite(next.dailyBudgetKWh)) {
    next.dailyBudgetKWh = clampKWh(next.dailyBudgetKWh);
  }
  next.controlledWeight = normaliseReserve(next.controlledWeight);
  next.priceFlexShare = normaliseFlex(next.priceFlexShare);
  workingDraft = next;
  pendingPreview = null;
  draftRevision += 1;
  status = draftsEqual(workingDraft, activeDraft) ? 'clean' : 'dirty';
  renderRequested();
};

export const previewBudgetAdjust = async (): Promise<void> => {
  if (busy) return;
  if (status === 'clean') return;
  busy = true;
  const requestRevision = draftRevision;
  renderRequested();
  try {
    const response = await callApi<DailyBudgetModelPreviewResponse | null>(
      'POST',
      SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH,
      toModelSettings(workingDraft),
    );
    if (requestRevision !== draftRevision) return;
    if (!response?.candidate) throw new Error('Daily budget preview is not available.');
    pendingPreview = response;
    status = 'pending';
    await showToast('Previewing daily budget changes.', 'ok');
  } catch (error) {
    if (requestRevision !== draftRevision) return;
    pendingPreview = null;
    status = draftsEqual(workingDraft, activeDraft) ? 'clean' : 'dirty';
    await logSettingsError('Failed to preview daily budget model', error, 'previewBudgetAdjust');
    await showToastError(error, 'Failed to preview daily budget changes.');
  } finally {
    busy = false;
    renderRequested();
  }
};

export const applyBudgetAdjust = async (): Promise<void> => {
  if (busy) return;
  if (status === 'clean' && !pendingPreview) return;
  busy = true;
  const requestRevision = draftRevision;
  renderRequested();
  try {
    const settings = pendingPreview?.settings ?? toModelSettings(workingDraft);
    const payload = await callApi<DailyBudgetUiPayload | null>(
      'POST',
      SETTINGS_UI_APPLY_DAILY_BUDGET_MODEL_PATH,
      settings,
    );
    const userEditedDuringApply = requestRevision !== draftRevision;
    activeDraft = fromModelSettings(settings);
    pendingPreview = null;
    if (!userEditedDuringApply) {
      workingDraft = activeDraft;
      status = 'clean';
    } else {
      status = draftsEqual(workingDraft, activeDraft) ? 'clean' : 'dirty';
    }
    await refreshActivePlan({ payload, appliedSettings: settings });
    await showToast('Daily budget model applied.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to apply daily budget model', error, 'applyBudgetAdjust');
    await showToastError(error, 'Failed to apply daily budget changes.');
    try {
      await refreshActivePlan();
      await loadBudgetAdjust({ fresh: true });
    } catch (refreshError) {
      await logSettingsError(
        'Failed to refresh state after apply error', refreshError, 'applyBudgetAdjust',
      );
    }
  } finally {
    busy = false;
    renderRequested();
  }
};

export const discardBudgetAdjust = (): void => {
  pendingPreview = null;
  workingDraft = activeDraft;
  status = 'clean';
  // Invalidate any in-flight preview/apply so a late response cannot resurrect
  // the discarded candidate.
  draftRevision += 1;
  renderRequested();
};
