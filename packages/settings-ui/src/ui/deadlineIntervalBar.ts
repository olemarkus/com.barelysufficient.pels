import type { CustomSeriesRenderItem } from 'echarts';

// Exact time bounds keep interval bars proportional on live and history charts.
export const renderDeadlineIntervalBar: CustomSeriesRenderItem = (_params, api) => {
  // This series uses Cartesian coordinates, so ECharts returns an x/y pair.
  const left = api.coord([api.value(0), 0]) as [number, number];
  const right = api.coord([api.value(1), api.value(2)]) as [number, number];
  return {
    type: 'rect',
    shape: { x: left[0] + 1, y: Math.min(left[1], right[1]),
      width: Math.max(1, right[0] - left[0] - 2), height: Math.max(3, Math.abs(left[1] - right[1])),
      r: [3, 3, 0, 0] },
    style: api.style(),
    emphasis: { style: api.styleEmphasis() },
  };
};
