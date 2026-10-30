// The settings UI's addressable pages and their URLs. Every shell page is a
// query-string route (`?page=budget`, `?page=settings/limits`), the same style
// as the Smart task routes (`?page=deadline-plan&deviceId=…`), so navigation
// stays inside one document, which the Homey WebView requires, and the
// fragment stays free for the web app's `#homey=`.

import type { SetupJourneyStep } from './setupJourneyState.ts';

const TOP_LEVEL_PANELS = ['overview', 'budget', 'usage', 'deadlines', 'settings'] as const;

// Views on the Budget panel that are pages of their own: the Daily budget
// editor opened from Settings (`settings/budget-adjust`) and the Weather
// insight (`budget/weather`). `tabNavigation.ts` opens their view when it
// renders the route.
export const BUDGET_VIEW_ROUTES = {
  'budget-adjust': 'settings/budget-adjust',
  'budget-weather': 'budget/weather',
} as const;
type BudgetViewRoute = keyof typeof BUDGET_VIEW_ROUTES;

// Settings hub sub-pages, addressed as `settings/<id>`.
export const SETTINGS_SUB_PANELS = [
  'recommendations',
  'setup-review',
  'limits',
  'devices',
  'modes',
  'electricity-prices',
  'price-aware-devices',
  'weather',
  'homes',
  'simulation',
  'web-app',
  'activity',
  'report-problem',
  'advanced',
] as const;

const SETTINGS_PREFIX = 'settings/';
const PAGE_PARAM = 'page';
// Parameters that belong to a route and must not leak into the next one.
const ROUTE_PARAMS = [
  'deviceId', 'historyId', 'edit', 'date', 'reportId', 'reportHomeId', 'reportDeviceId', 'reportAtMs',
  'setup',
];

const isTopLevel = (id: string): boolean => (TOP_LEVEL_PANELS as readonly string[]).includes(id);
const isSettingsSub = (id: string): boolean => (SETTINGS_SUB_PANELS as readonly string[]).includes(id);
export const isBudgetViewRoute = (id: string): id is BudgetViewRoute => (
  Object.prototype.hasOwnProperty.call(BUDGET_VIEW_ROUTES, id)
);
const budgetViewRouteFor = (page: string): BudgetViewRoute | null => (
  (Object.keys(BUDGET_VIEW_ROUTES) as BudgetViewRoute[]).find((route) => BUDGET_VIEW_ROUTES[route] === page) ?? null
);

// The panel a URL names, or null when it names no shell page (no `page`, an
// unknown one, or a route another router owns such as the Smart task page).
export const panelFromSearch = (search: string): string | null => {
  const page = new URLSearchParams(search).get(PAGE_PARAM);
  if (!page) return null;
  if (isTopLevel(page)) return page;
  const budgetView = budgetViewRouteFor(page);
  if (budgetView) return budgetView;
  if (page.startsWith(SETTINGS_PREFIX)) {
    const sub = page.slice(SETTINGS_PREFIX.length);
    return isSettingsSub(sub) ? sub : null;
  }
  return null;
};

export const isShellPanel = (panelId: string): boolean => (
  isTopLevel(panelId) || isSettingsSub(panelId) || isBudgetViewRoute(panelId)
);

// The URL for a shell page, keeping the current path, fragment and any
// parameter no route owns.
export const shellRouteUrl = (
  panelId: string, location: Pick<Location, 'pathname' | 'search' | 'hash'>, setup?: SetupJourneyStep,
): string => {
  const params = new URLSearchParams(location.search);
  for (const param of ROUTE_PARAMS) params.delete(param);
  let page: string = panelId;
  if (isSettingsSub(panelId)) page = `${SETTINGS_PREFIX}${panelId}`;
  else if (isBudgetViewRoute(panelId)) page = BUDGET_VIEW_ROUTES[panelId];
  params.set(PAGE_PARAM, page);
  if (setup) params.set('setup', setup);
  return `${location.pathname}?${params.toString()}${location.hash}`;
};
