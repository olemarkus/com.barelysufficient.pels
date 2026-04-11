const echarts = require('echarts') as {
  init: (dom: HTMLElement, theme?: string | object | null, opts?: Record<string, unknown>) => unknown;
  use: (extensions: unknown[]) => void;
  format?: {
    encodeHTML?: (value: string) => string;
  };
};

const noopInstaller = () => {
  // Vitest aliases ECharts subpath modules to the CJS bundle; installers can be no-op.
};

export const init = echarts.init;
export const use = echarts.use;

const fallbackEncodeHtml = (value: string): string => (
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
);

const encodeHTML = echarts.format?.encodeHTML ?? fallbackEncodeHtml;
export const format = { encodeHTML };

export const BarChart = noopInstaller;
export const HeatmapChart = noopInstaller;
export const ScatterChart = noopInstaller;
export const GridComponent = noopInstaller;
export const LegendComponent = noopInstaller;
export const TooltipComponent = noopInstaller;
export const VisualMapComponent = noopInstaller;
export const SVGRenderer = noopInstaller;
