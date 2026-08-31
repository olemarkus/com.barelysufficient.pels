import type { DailyBudgetUiPayload, DailyBudgetUiRead } from '../../../contracts/src/dailyBudgetTypes.ts';
import { callApi, getSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { type CostDisplay } from './dailyBudgetCost.ts';
import { getPricesReadModel } from './prices.ts';
import {
  initBudgetRedesignHandlers,
  renderBudgetRedesign,
  updateBudgetPriceLevel,
  type BudgetDayView,
} from './budgetRedesign.ts';
import { setBudgetAdjustRefresh } from './budgetAdjustController.ts';
import { resolveCostDisplayFromCombinedPrices } from './priceUnit.ts';
import { normalizeCombinedPrices, type CombinedPriceRow } from './combinedPrices.ts';
import { setActiveDailyBudgetFromPayload } from './activeDailyBudget.ts';

let currentDailyBudgetView: BudgetDayView = 'today';
let latestDailyBudgetRead: DailyBudgetUiRead = { kind: 'unavailable' };
let costDisplay: CostDisplay = resolveCostDisplayFromCombinedPrices(null);
// Normalized combined-price rows for the hero's "Export price now" subline —
// refreshed alongside costDisplay from the same prices read-model fetch.
let latestPriceRows: CombinedPriceRow[] = [];

// The planning-price (`budgetPrice`) overlay and the "Export price now" subline
// must follow the CURRENT export-price setting, not the cached prices:
// `combined_prices` keeps carrying `budgetPrice`/`exportPrice` for up to an hour
// after the user disables export pricing (they only drop on the next rebuild).
// When export is off, drop both so the Budget chart never shows a stale "using
// your solar" divergence or export subline — mirrors the Electricity "Right now"
// card gate. Reference-identical row objects when enabled (no re-map).
export const gateExportPriceRows = (
  rows: CombinedPriceRow[],
  exportEnabled: boolean,
): CombinedPriceRow[] => (
  exportEnabled ? rows : rows.map((row) => ({ ...row, budgetPrice: undefined, exportPrice: undefined }))
);

// The Homey API bridge is an untrusted transport, so the wire value is
// shape-guarded HERE and nowhere else (AGENTS.md, "Clean and trusted
// interfaces"): the `budget` discriminant alone is a compile-time claim, and a
// partial `{ kind: 'budget' }` off the bridge would hand the render tree an
// `undefined` to index. Guarded are exactly the two fields this adapter and its
// render tree dereference — `days` and `todayKey`; anything short of that reads
// as `unavailable`, which the surface already draws.
export const asBudgetPayload = (read: unknown): DailyBudgetUiPayload | null => {
  if (typeof read !== 'object' || read === null) return null;
  const { kind, payload } = read as { kind?: unknown; payload?: unknown };
  if (kind !== 'budget' || typeof payload !== 'object' || payload === null) return null;
  const { days, todayKey } = payload as { days?: unknown; todayKey?: unknown };
  if (typeof days !== 'object' || days === null || typeof todayKey !== 'string') return null;
  return payload as DailyBudgetUiPayload;
};

const renderDailyBudget = (read: DailyBudgetUiRead) => {
  const payload = asBudgetPayload(read);
  latestDailyBudgetRead = payload === null ? { kind: 'unavailable' } : { kind: 'budget', payload };
  // Keep the chart-overlay budget source in lockstep with what the Budget
  // hero renders (see `activeDailyBudget.ts` for why the budget-adjust draft
  // is not a valid source).
  setActiveDailyBudgetFromPayload(payload);
  renderBudgetRedesign(payload, currentDailyBudgetView, costDisplay, latestPriceRows);
};

// Side-channel for power-derived signals that aren't carried on the daily
// budget payload itself. Price-level (cheap/expensive) is shared between the
// Overview hero and the Budget page; piping it through realtime keeps both
// surfaces aligned without rebuilding the budget payload on every tick.
export const updateBudgetPower = (
  power: { priceLevel?: string | null } | null,
): void => {
  updateBudgetPriceLevel(power?.priceLevel ?? null);
};

export const refreshDailyBudgetPlan = async (readOverride?: DailyBudgetUiRead) => {
  try {
    const hasExplicitPayload = readOverride !== undefined;
    const [read, combinedPrices, exportEnabled] = await Promise.all([
      hasExplicitPayload
        ? Promise.resolve(readOverride)
        : callApi<DailyBudgetUiRead>('GET', '/daily_budget'),
      getPricesReadModel().then((prices) => prices.combinedPrices).catch(() => null),
      getSetting('export_price_enabled').then((value) => value === true).catch(() => false),
    ]);
    costDisplay = resolveCostDisplayFromCombinedPrices(combinedPrices);
    latestPriceRows = gateExportPriceRows(normalizeCombinedPrices(combinedPrices), exportEnabled);
    renderDailyBudget(read);
  } catch (error) {
    await logSettingsError('Failed to load daily budget plan', error, 'refreshDailyBudgetPlan');
    renderDailyBudget({ kind: 'unavailable' });
  }
};

const setDailyBudgetView = (view: BudgetDayView) => {
  if (currentDailyBudgetView === view) return;
  currentDailyBudgetView = view;
  renderDailyBudget(latestDailyBudgetRead);
};

export const initDailyBudgetHandlers = () => {
  initBudgetRedesignHandlers(setDailyBudgetView);
  setBudgetAdjustRefresh(async (args) => {
    await refreshDailyBudgetPlan(args?.payload);
  });
};
