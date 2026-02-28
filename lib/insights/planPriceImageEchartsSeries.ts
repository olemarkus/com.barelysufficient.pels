import { PLAN_PRICE_COLORS as COLORS, PLAN_PRICE_FONT_SIZES as FONT_SIZES, PLAN_PRICE_LAYOUT } from './planPriceImageTheme';

type LegendTextStyle = {
  color?: string;
  fontSize?: number;
};

type LegendOption = {
  left?: number | string;
  bottom?: number | string;
  selectedMode?: boolean | 'single' | 'multiple';
  itemWidth?: number;
  itemHeight?: number;
  itemGap?: number;
  textStyle?: LegendTextStyle;
  data?: string[];
};

type EChartsOption = {
  legend?: LegendOption | LegendOption[];
};

type ScatterSeriesOption = {
  name?: string;
  type: 'scatter';
  yAxisIndex?: number;
  data?: Array<number | null>;
  symbol?: string;
  symbolSize?: number;
  itemStyle?: {
    color?: string;
    borderColor?: string;
    borderWidth?: number;
  };
  emphasis?: {
    disabled?: boolean;
  };
  z?: number;
};

const PADDING = PLAN_PRICE_LAYOUT.padding;
const DOT_RADIUS = PLAN_PRICE_LAYOUT.dotRadius;

const ACTUAL_LEGEND_TEXT = 'Actual';

type ActualSeriesContext = {
  actualKWh: Array<number | null>;
  showActual: boolean;
  currentIndex: number;
};

export const buildActualSeries = (params: {
  context: ActualSeriesContext;
}): ScatterSeriesOption => {
  const { context } = params;
  return {
    name: ACTUAL_LEGEND_TEXT,
    type: 'scatter',
    yAxisIndex: 0,
    data: context.actualKWh.map((value, index) => {
      if (!context.showActual || index > context.currentIndex) return null;
      return Number.isFinite(value) ? value : null;
    }),
    symbol: 'circle',
    symbolSize: DOT_RADIUS * 2,
    itemStyle: {
      color: COLORS.actual,
      borderColor: COLORS.background,
      borderWidth: 2,
    },
    emphasis: { disabled: true },
    z: 4,
  };
};

export const buildLegendOption = (params: {
  legendTexts: { plan: string; price: string };
  showActual: boolean;
}): NonNullable<EChartsOption['legend']> => ({
  left: PADDING,
  bottom: PADDING + 2,
  selectedMode: false,
  itemWidth: 16,
  itemHeight: 10,
  itemGap: 14,
  textStyle: { color: COLORS.muted, fontSize: FONT_SIZES.legend },
  data: params.showActual
    ? [params.legendTexts.plan, ACTUAL_LEGEND_TEXT, params.legendTexts.price]
    : [params.legendTexts.plan, params.legendTexts.price],
});
