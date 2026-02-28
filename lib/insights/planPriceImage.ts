import fs from 'node:fs';
import path from 'node:path';

import type { CombinedPriceData } from '../dailyBudget/dailyBudgetMath';
import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import { buildPlanPriceSvgWithEcharts } from './planPriceImageEcharts';
import { PLAN_PRICE_VIEWPORT } from './planPriceImageTheme';
import { startRuntimeSpan } from '../utils/runtimeTrace';

type PlanPriceImageParams = {
  snapshot: DailyBudgetUiPayload | null;
  dayKey?: string | null;
  combinedPrices?: CombinedPriceData | null;
  width?: number;
  height?: number;
};

const DEFAULT_WIDTH = PLAN_PRICE_VIEWPORT.width;
const DEFAULT_HEIGHT = PLAN_PRICE_VIEWPORT.height;

const FONT_FILES = resolveFontFiles();
const DEFAULT_FONT_FAMILY = FONT_FILES.length > 0 ? 'IBM Plex Sans' : 'sans-serif';
let resvgPromise: Promise<typeof import('@resvg/resvg-js')> | null = null;

export async function buildPlanPricePng(params: PlanPriceImageParams): Promise<Uint8Array> {
  const stopSpan = startRuntimeSpan('camera_png_build');
  const width = params.width ?? DEFAULT_WIDTH;
  const height = params.height ?? DEFAULT_HEIGHT;
  try {
    const svg = await buildPlanPriceSvgWithEcharts({
      ...params,
      width,
      height,
      fontFamily: DEFAULT_FONT_FAMILY,
    });
    return renderSvgToPng(svg, width);
  } finally {
    stopSpan();
  }
}

const loadResvg = async (): Promise<typeof import('@resvg/resvg-js')> => (
  resvgPromise ??= import('@resvg/resvg-js')
);

const renderSvgToPng = async (svg: string, width: number): Promise<Uint8Array> => {
  const stopSpan = startRuntimeSpan('camera_png_resvg');
  const { renderAsync } = await loadResvg();
  const baseOptions = { fitTo: { mode: 'width', value: width } } as const;
  const fontOptions = {
    font: {
      loadSystemFonts: FONT_FILES.length === 0,
      defaultFontFamily: DEFAULT_FONT_FAMILY,
      sansSerifFamily: DEFAULT_FONT_FAMILY,
      ...(FONT_FILES.length > 0 ? { fontFiles: FONT_FILES } : {}),
    },
  };

  try {
    const rendered = await renderAsync(svg, { ...baseOptions, ...fontOptions });
    return rendered.asPng();
  } catch (error) {
    console.warn('Plan image: failed to render with custom fonts, falling back', error);
    const rendered = await renderAsync(svg, baseOptions);
    return rendered.asPng();
  } finally {
    stopSpan();
  }
};

function resolveFontFiles(): string[] {
  const baseDir = path.resolve(__dirname, '../../assets/fonts');
  const fontFiles = [
    path.join(baseDir, 'IBMPlexSans-Regular.ttf'),
    path.join(baseDir, 'IBMPlexSans-SemiBold.ttf'),
  ];
  return fontFiles.filter((file) => fs.existsSync(file));
}
