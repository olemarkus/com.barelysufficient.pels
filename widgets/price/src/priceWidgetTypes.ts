// Browser-safe payload types for the price widget. The node builder
// (`priceWidgetPayload.ts`) produces these; the WebView renderer consumes them
// and never does unit, time-zone or level math of its own.

/** What the owner chose to show, from the widget's "Show" setting. */
export type PriceWidgetShow = 'import' | 'export' | 'both';

export type PriceWidgetShadeLevel = 'cheap' | 'expensive';

/** One price held from `startMs` to `endMs`. */
export type PriceWidgetStep = {
  startMs: number;
  endMs: number;
  price: number;
};

/** A run of consecutive periods at one non-normal level. */
export type PriceWidgetShade = {
  startMs: number;
  endMs: number;
  level: PriceWidgetShadeLevel;
};

export type PriceWidgetTick = {
  value: number;
  label: string;
};

export type PriceWidgetTimeTick = {
  atMs: number;
  label: string;
};

export type PriceWidgetChart = {
  windowStartMs: number;
  windowEndMs: number;
  nowMs: number;
  yMin: number;
  yMax: number;
  yTicks: PriceWidgetTick[];
  timeTicks: PriceWidgetTimeTick[];
  /** Local midnights inside the window, labelled with the day they start. */
  dayDividers: PriceWidgetTimeTick[];
  importSteps: PriceWidgetStep[];
  exportSteps: PriceWidgetStep[];
  shades: PriceWidgetShade[];
  /** The price the "now" dot sits on, in the series the headline shows. */
  nowPrice: number;
  axisUnit: string;
};

export type PriceWidgetLegendItem = {
  key: 'cheap' | 'expensive' | 'import' | 'export';
  label: string;
};

export type PriceWidgetReadyPayload = {
  state: 'ready';
  title: string;
  priceText: string;
  /**
   * The current import level. `tone` is null for a normal level (plain text,
   * no chip). The whole field is null in the export view, which has no levels.
   */
  level: { label: string; tone: PriceWidgetShadeLevel | null } | null;
  subline: string;
  caption: string | null;
  chart: PriceWidgetChart;
  legend: PriceWidgetLegendItem[];
  ariaLabel: string;
};

export type PriceWidgetEmptyPayload = {
  state: 'empty';
  title: string;
  subtitle: string;
};

export type PriceWidgetPayload = PriceWidgetReadyPayload | PriceWidgetEmptyPayload;
