export const PLAN_PRICE_LAYOUT = {
  padding: 20,
  headerHeight: 12,
  axisLabelHeight: 24,
  legendHeight: 60,
  gridLines: 4,
  barRadius: 3,
  dotRadius: 4,
  priceLineWidth: 4,
  priceLineOutlineWidth: 8,
} as const;

export const PLAN_PRICE_FONT_SIZES = {
  title: 24,
  meta: 16,
  now: 16,
  axis: 17,
  legend: 16,
  label: 16,
} as const;

export const PLAN_PRICE_COLORS = {
  background: '#0c111b',
  panel: 'rgba(255, 255, 255, 0.04)',
  panelBorder: 'rgba(255, 255, 255, 0.12)',
  grid: 'rgba(255, 255, 255, 0.2)',
  text: '#e6ecf5',
  muted: '#a8b8c8',
  plan: '#7fd1ae',
  actual: '#64b5f6',
  price: '#f26b6b',
  priceShadow: '#0d1117',
  nowFill: 'rgba(100, 181, 246, 0.12)',
  nowStroke: '#64b5f6',
} as const;
