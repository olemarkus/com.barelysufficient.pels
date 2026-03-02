import { BarChart, HeatmapChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import { format, init, use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

type EChartsInitOpts = Record<string, unknown>;
type EChartsOption = Record<string, unknown>;
type EChartsType = {
  setOption: (option: EChartsOption, opts?: Record<string, unknown>) => void;
  resize: (opts?: Record<string, unknown>) => void;
  dispose: () => void;
};
type SeriesOption = Record<string, unknown>;

let isRegistered = false;

const ensureRegistry = () => {
  if (isRegistered) return;
  use([
    BarChart,
    HeatmapChart,
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
