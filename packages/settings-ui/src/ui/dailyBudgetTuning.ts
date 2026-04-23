import {
  dailyBudgetAdvancedForm,
  dailyBudgetControlledWeightInput,
  dailyBudgetControlledWeightValue,
  dailyBudgetControlledPreview,
  dailyBudgetPriceFlexShareInput,
  dailyBudgetPriceFlexShareValue,
  dailyBudgetPriceFlexPreview,
  dailyBudgetBreakdownInput,
  dailyBudgetTuningResetButton,
  dailyBudgetTuningSummary,
} from './dom.ts';
import { getSetting } from './homey.ts';
import { pushSettingWriteIfChanged } from './settingWrites.ts';
import { logSettingsError } from './logging.ts';
import { showToast, showToastError } from './toast.ts';
import {
  CONTROLLED_USAGE_WEIGHT,
  PRICE_SHAPING_FLEX_SHARE,
} from '../../../contracts/src/dailyBudgetConstants.ts';
import {
  DAILY_BUDGET_CONTROLLED_WEIGHT,
  DAILY_BUDGET_BREAKDOWN_ENABLED,
  DAILY_BUDGET_PRICE_FLEX_SHARE,
} from '../../../contracts/src/settingsKeys.ts';
import { rerenderDailyBudget } from './dailyBudget.ts';

const clampRatio = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
};

const parseRatioInput = (value: string, fallback: number): number => {
  const parsed = Number.parseFloat(value);
  return clampRatio(parsed, fallback);
};

const setInputValue = (input: HTMLInputElement | null, value: number) => {
  if (!input) return;
  const target = input;
  target.value = value.toString();
};

const formatRatio = (value: number) => value.toFixed(2);

const buildPreviewBars = (values: number[], toneClass: string) => (
  `<div class="advanced-preview-card__bars">`
  + values.map((height) => (
    `<span class="advanced-preview-card__bar ${toneClass}" style="height:${height}%"></span>`
  )).join('')
  + `</div>`
);

const renderPreviewCards = (
  container: HTMLElement | null,
  cards: Array<{ title: string; note: string; values: number[]; toneClass: string }>,
) => {
  if (!container) return;
  const target = container;
  target.innerHTML = cards.map((card) => `
    <div class="advanced-preview-card">
      <strong>${card.title}</strong>
      <p class="muted">${card.note}</p>
      ${buildPreviewBars(card.values, card.toneClass)}
    </div>
  `).join('');
};

const getControlledPreviewCards = (value: number) => {
  const center = Math.round(value * 100);
  return [
    {
      title: 'Less control-led',
      note: 'Keeps the daily shape steadier and closer to background demand.',
      values: [48, 50, 52, 51, 49, 47, 45, 46, 49, 54, 58, 55],
      toneClass: 'advanced-preview-card__bar--soft',
    },
    {
      title: `Current mix ${center}%`,
      note: 'Blends your learned base load with whatever flexible demand usually responds.',
      values: [44, 46, 48, 50, 47, 45, 42, 46, 54, 62, 58, 51],
      toneClass: 'advanced-preview-card__bar--current',
    },
    {
      title: 'More control-led',
      note: 'Lets flexible devices pull more of the daily curve toward active control windows.',
      values: [40, 42, 44, 47, 45, 43, 38, 45, 58, 70, 64, 54],
      toneClass: 'advanced-preview-card__bar--strong',
    },
  ];
};

const getPricePreviewCards = (value: number) => {
  const center = Math.round(value * 100);
  return [
    {
      title: 'Lower price influence',
      note: 'Cheaper hours help a little, but the day stays close to its normal rhythm.',
      values: [42, 42, 43, 44, 46, 47, 48, 49, 50, 51, 52, 52],
      toneClass: 'advanced-preview-card__bar--soft',
    },
    {
      title: `Current pull ${center}%`,
      note: 'Moves flexible load toward cheap hours without flattening the whole day.',
      values: [38, 39, 44, 50, 58, 63, 56, 48, 44, 41, 39, 38],
      toneClass: 'advanced-preview-card__bar--current',
    },
    {
      title: 'Higher price influence',
      note: 'Cheap hours pull more of the flexible budget forward and evenings get tighter.',
      values: [34, 35, 46, 58, 70, 76, 60, 46, 38, 34, 32, 31],
      toneClass: 'advanced-preview-card__bar--strong',
    },
  ];
};

const renderTuningPreview = () => {
  const controlledWeight = parseRatioInput(
    dailyBudgetControlledWeightInput?.value ?? '',
    CONTROLLED_USAGE_WEIGHT,
  );
  const priceFlexShare = parseRatioInput(
    dailyBudgetPriceFlexShareInput?.value ?? '',
    PRICE_SHAPING_FLEX_SHARE,
  );
  if (dailyBudgetControlledWeightValue) {
    dailyBudgetControlledWeightValue.textContent = formatRatio(controlledWeight);
  }
  if (dailyBudgetPriceFlexShareValue) {
    dailyBudgetPriceFlexShareValue.textContent = formatRatio(priceFlexShare);
  }
  renderPreviewCards(dailyBudgetControlledPreview, getControlledPreviewCards(controlledWeight));
  renderPreviewCards(dailyBudgetPriceFlexPreview, getPricePreviewCards(priceFlexShare));
  if (dailyBudgetTuningSummary) {
    dailyBudgetTuningSummary.textContent = `Current tuning: ${
      Math.round(controlledWeight * 100)
    }% control-led shaping and ${Math.round(priceFlexShare * 100)}% price pull. `
      + 'Save only after checking whether the stronger preview still looks believable for your home.';
  }
};

export const loadDailyBudgetTuningSettings = async () => {
  if (!dailyBudgetControlledWeightInput && !dailyBudgetPriceFlexShareInput && !dailyBudgetBreakdownInput) return;
  const [controlledWeightRaw, priceFlexShareRaw, breakdownRaw] = await Promise.all([
    getSetting(DAILY_BUDGET_CONTROLLED_WEIGHT),
    getSetting(DAILY_BUDGET_PRICE_FLEX_SHARE),
    getSetting(DAILY_BUDGET_BREAKDOWN_ENABLED),
  ]);
  const controlledWeight = clampRatio(
    typeof controlledWeightRaw === 'number' ? controlledWeightRaw : Number.NaN,
    CONTROLLED_USAGE_WEIGHT,
  );
  const priceFlexShare = clampRatio(
    typeof priceFlexShareRaw === 'number' ? priceFlexShareRaw : Number.NaN,
    PRICE_SHAPING_FLEX_SHARE,
  );
  setInputValue(dailyBudgetControlledWeightInput, controlledWeight);
  setInputValue(dailyBudgetPriceFlexShareInput, priceFlexShare);
  if (dailyBudgetBreakdownInput) {
    dailyBudgetBreakdownInput.checked = breakdownRaw === true;
  }
  renderTuningPreview();
};

const saveDailyBudgetTuningSettings = async () => {
  const controlledWeight = parseRatioInput(
    dailyBudgetControlledWeightInput?.value ?? '',
    CONTROLLED_USAGE_WEIGHT,
  );
  const priceFlexShare = parseRatioInput(
    dailyBudgetPriceFlexShareInput?.value ?? '',
    PRICE_SHAPING_FLEX_SHARE,
  );
  const breakdownEnabled = dailyBudgetBreakdownInput?.checked ?? false;

  const [currentControlledWeight, currentPriceFlexShare, currentBreakdown] = await Promise.all([
    getSetting(DAILY_BUDGET_CONTROLLED_WEIGHT),
    getSetting(DAILY_BUDGET_PRICE_FLEX_SHARE),
    getSetting(DAILY_BUDGET_BREAKDOWN_ENABLED),
  ]);

  const writes: Array<Promise<void>> = [];
  pushSettingWriteIfChanged(
    writes,
    DAILY_BUDGET_CONTROLLED_WEIGHT,
    currentControlledWeight,
    controlledWeight,
  );
  pushSettingWriteIfChanged(
    writes,
    DAILY_BUDGET_PRICE_FLEX_SHARE,
    currentPriceFlexShare,
    priceFlexShare,
  );
  pushSettingWriteIfChanged(
    writes,
    DAILY_BUDGET_BREAKDOWN_ENABLED,
    currentBreakdown,
    breakdownEnabled,
  );
  if (writes.length > 0) {
    await Promise.all(writes);
  }

  setInputValue(dailyBudgetControlledWeightInput, controlledWeight);
  setInputValue(dailyBudgetPriceFlexShareInput, priceFlexShare);
  if (dailyBudgetBreakdownInput) {
    dailyBudgetBreakdownInput.checked = breakdownEnabled;
  }
  renderTuningPreview();
  rerenderDailyBudget();
};

export const initDailyBudgetTuningHandlers = () => {
  if (!dailyBudgetControlledWeightInput && !dailyBudgetPriceFlexShareInput && !dailyBudgetBreakdownInput) return;
  const autoSave = async () => {
    try {
      await saveDailyBudgetTuningSettings();
      await showToast('Daily budget tuning saved.', 'ok');
    } catch (error) {
      await logSettingsError('Failed to save daily budget tuning', error, 'dailyBudgetTuning');
      await showToastError(error, 'Failed to save daily budget tuning.');
    }
  };

  dailyBudgetControlledWeightInput?.addEventListener('input', renderTuningPreview);
  dailyBudgetControlledWeightInput?.addEventListener('change', autoSave);
  dailyBudgetPriceFlexShareInput?.addEventListener('input', renderTuningPreview);
  dailyBudgetPriceFlexShareInput?.addEventListener('change', autoSave);
  dailyBudgetBreakdownInput?.addEventListener('change', autoSave);
  dailyBudgetTuningResetButton?.addEventListener('click', async () => {
    setInputValue(dailyBudgetControlledWeightInput, CONTROLLED_USAGE_WEIGHT);
    setInputValue(dailyBudgetPriceFlexShareInput, PRICE_SHAPING_FLEX_SHARE);
    if (dailyBudgetBreakdownInput) {
      dailyBudgetBreakdownInput.checked = false;
    }
    renderTuningPreview();
    await autoSave();
  });
  dailyBudgetAdvancedForm?.addEventListener('submit', (event) => event.preventDefault());
  renderTuningPreview();
};
