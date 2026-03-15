import v8 from 'node:v8';
import type { CombinedPriceData } from '../dailyBudget/dailyBudgetMath';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { buildPlanPricePngWithCanvas, initCanvasRuntime } from './planPriceImageEcharts';
import { startRuntimeSpan } from '../utils/runtimeTrace';

type PlanPriceImageParams = {
  snapshot: DailyBudgetUiPayload | null;
  dayKey?: string | null;
  combinedPrices?: CombinedPriceData | null;
  width?: number;
  height?: number;
};

const FONT_FAMILY = 'IBMPlexSans';

const MB = 1024 * 1024;

let canvasInitialized = false;
let renderCount = 0;

const ensureCanvasRuntime = (): void => {
  if (canvasInitialized) return;
  initCanvasRuntime();
  canvasInitialized = true;
};

const getHeapMb = (): { heapUsed: number; external: number; malloc: number } => {
  try {
    const h = v8.getHeapStatistics();
    return {
      heapUsed: Math.round(h.used_heap_size / MB * 10) / 10,
      external: Math.round(h.external_memory / MB * 10) / 10,
      malloc: Math.round(h.malloced_memory / MB * 10) / 10,
    };
  } catch {
    return { heapUsed: -1, external: -1, malloc: -1 };
  }
};

export async function buildPlanPricePng(
  params: PlanPriceImageParams,
): Promise<Uint8Array> {
  const stopSpan = startRuntimeSpan('camera_png_build');
  const before = getHeapMb();
  const id = ++renderCount;
  try {
    ensureCanvasRuntime();
    const png = await buildPlanPricePngWithCanvas({
      ...params,
      width: params.width ?? 480,
      height: params.height ?? 480,
      fontFamily: FONT_FAMILY,
    });
    const after = getHeapMb();
    console.log(
      `[plan-image] canvas render #${id}`
      + ` heapUsed=${before.heapUsed}->${after.heapUsed}MB`
      + ` external=${before.external}->${after.external}MB`
      + ` malloc=${before.malloc}->${after.malloc}MB`
      + ` png=${png.length}bytes`,
    );
    return png;
  } finally {
    stopSpan();
  }
}
