import { BarChart, LineChart, ScatterChart } from 'echarts/charts';
import { GraphicComponent, GridComponent, LegendComponent } from 'echarts/components';
import { init, setPlatformAPI, use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

use([
  BarChart,
  LineChart,
  ScatterChart,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  CanvasRenderer,
]);

export {
  init,
  setPlatformAPI,
};
