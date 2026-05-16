import { BarChart, HeatmapChart, LineChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { format, init, use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

type EChartsInitOpts = Record<string, unknown>;
type EChartsOption = Record<string, unknown>;
type EChartsType = {
  setOption: (option: EChartsOption, opts?: Record<string, unknown>) => void;
  resize: (opts?: Record<string, unknown>) => void;
  dispose: () => void;
  // `convertToPixel` returns the pixel position of a data point in the
  // chart's coordinate system. Used by the deadline-plan bar-centre parity
  // test to verify both grids resolve the same `xAxisIndex × dataIndex` to
  // the same `[x, y]` pixel; without exposing the method the test would have
  // to parse SVG path geometry, which is brittle across renderer versions.
  convertToPixel: (
    finder: { xAxisIndex?: number; yAxisIndex?: number; gridIndex?: number; seriesIndex?: number },
    value: number | string | Array<number | string>,
  ) => number | number[];
};
type SeriesOption = Record<string, unknown>;

let isRegistered = false;

const ensureRegistry = () => {
  if (isRegistered) return;
  use([
    BarChart,
    HeatmapChart,
    LineChart,
    GridComponent,
    LegendComponent,
    TooltipComponent,
    VisualMapComponent,
    SVGRenderer,
  ]);
  isRegistered = true;
};

export const initEcharts = (
  dom: HTMLElement,
  theme?: string | object | null,
  opts?: EChartsInitOpts,
): EChartsType => {
  ensureRegistry();
  return init(dom, theme, opts) as EChartsType;
};

export const encodeHtml = (value: string): string => format.encodeHTML(value);

export type {
  EChartsOption,
  EChartsType,
  SeriesOption,
};
