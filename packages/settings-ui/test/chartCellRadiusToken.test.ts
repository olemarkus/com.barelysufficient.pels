import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/* -------------------------------------------------------------------------- *
 * Heatmap cell-radius token promotion regression.
 *
 * Before this rebind the heatmap cell radius lived as two parallel literals
 * (`border-radius: var(--radius-xs)` in `.usage-legend__swatch--unreliable`
 * + a `getComputedStyle('--radius-xs')` read in `powerWeekChartEcharts.ts`),
 * which meant any future change to the cell shape would have had to touch
 * two files and could silently drift. Promoting to `--pels-chart-cell-radius`
 * gives the legend/cell shape contract a single chart-scoped source of truth.
 *
 * These assertions lock the contract end-to-end:
 *   1. `tokens.css` defines `--pels-chart-cell-radius` (style-dictionary
 *      output from `tokens/component.json`).
 *   2. `.usage-legend__swatch--unreliable` consumes `var(--pels-chart-cell-radius)`
 *      in `public/style.css`.
 *   3. `resolveCellRadius` in `powerWeekChartEcharts.ts` reads the same
 *      `--pels-chart-cell-radius` custom property at runtime and parses the
 *      px value (verified via the rendered ECharts heatmap `borderRadius`).
 * -------------------------------------------------------------------------- */

const STYLE_CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');
const TOKENS_CSS_PATH = path.join(__dirname, '..', 'dist', 'tokens.css');

describe('heatmap cell-radius token (--pels-chart-cell-radius)', () => {
  it('is declared in the generated tokens.css', () => {
    const tokensCss = fs.readFileSync(TOKENS_CSS_PATH, 'utf8');
    // The token resolves through `outputReferences` to `var(--radius-xs)`,
    // so the LHS declaration is what we assert here.
    expect(tokensCss).toMatch(/--pels-chart-cell-radius:\s*[^;]+;/);
  });

  it('powers .usage-legend__swatch--unreliable in public/style.css', () => {
    const styleCss = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
    const rule = styleCss.match(
      /\.usage-legend__swatch--unreliable\s*\{[^}]*\}/,
    );
    expect(rule).not.toBeNull();
    expect(rule?.[0] ?? '').toMatch(
      /border-radius:\s*var\(--pels-chart-cell-radius\)\s*;/,
    );
    // Defensive: ensure the swatch is not still pinned to `--radius-xs`.
    expect(rule?.[0] ?? '').not.toMatch(
      /border-radius:\s*var\(--radius-xs\)/,
    );
  });

  it('resolveCellRadius reads --pels-chart-cell-radius and parses the px value', async () => {
    const initEcharts = vi.fn(() => ({
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    }));
    vi.doMock('../src/ui/echartsRegistry.ts', () => ({
      initEcharts,
      encodeHtml: (value: string) => value,
    }));

    const getPropertyValue = vi.fn((variable: string): string => {
      if (variable === '--pels-chart-cell-radius') return '2px';
      return '';
    });
    const getComputedStyleSpy = vi
      .spyOn(globalThis, 'getComputedStyle')
      .mockReturnValue({ getPropertyValue } as unknown as CSSStyleDeclaration);

    try {
      const { renderPowerWeekChart } = await import(
        '../src/ui/powerWeekChartEcharts.ts'
      );
      const container = document.createElement('div');
      document.body.appendChild(container);

      const rendered = renderPowerWeekChart({
        container,
        entries: [{ hour: new Date('2025-01-13T00:00:00.000Z'), kWh: 1.2 }],
        startMs: Date.parse('2025-01-13T00:00:00.000Z'),
        endMs: Date.parse('2025-01-20T00:00:00.000Z'),
        timeZone: 'UTC',
      });

      expect(rendered).toBe(true);
      const results = initEcharts.mock.results;
      const lastInit = results[results.length - 1];
      const chart = lastInit?.value as { setOption: ReturnType<typeof vi.fn> };
      const option = chart.setOption.mock.calls[0][0] as {
        series?: Array<{
          type?: string;
          itemStyle?: { borderRadius?: number };
        }>;
      };
      const heatmap = option.series?.find((series) => series.type === 'heatmap');
      expect(heatmap?.itemStyle?.borderRadius).toBe(2);
      expect(getPropertyValue).toHaveBeenCalledWith('--pels-chart-cell-radius');
    } finally {
      getComputedStyleSpy.mockRestore();
      vi.doUnmock('../src/ui/echartsRegistry.ts');
    }
  });

  it('resolveCellRadius falls back to 2 when the token is missing', async () => {
    const initEcharts = vi.fn(() => ({
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    }));
    vi.doMock('../src/ui/echartsRegistry.ts', () => ({
      initEcharts,
      encodeHtml: (value: string) => value,
    }));

    const getComputedStyleSpy = vi
      .spyOn(globalThis, 'getComputedStyle')
      .mockReturnValue({
        getPropertyValue: () => '',
      } as unknown as CSSStyleDeclaration);

    try {
      vi.resetModules();
      const { renderPowerWeekChart } = await import(
        '../src/ui/powerWeekChartEcharts.ts'
      );
      const container = document.createElement('div');
      document.body.appendChild(container);

      const rendered = renderPowerWeekChart({
        container,
        entries: [{ hour: new Date('2025-01-13T00:00:00.000Z'), kWh: 1.2 }],
        startMs: Date.parse('2025-01-13T00:00:00.000Z'),
        endMs: Date.parse('2025-01-20T00:00:00.000Z'),
        timeZone: 'UTC',
      });

      expect(rendered).toBe(true);
      const results = initEcharts.mock.results;
      const lastInit = results[results.length - 1];
      const chart = lastInit?.value as { setOption: ReturnType<typeof vi.fn> };
      const option = chart.setOption.mock.calls[0][0] as {
        series?: Array<{
          type?: string;
          itemStyle?: { borderRadius?: number };
        }>;
      };
      const heatmap = option.series?.find((series) => series.type === 'heatmap');
      // Fallback constant mirrors the `{radius.xs}` source value (2 px).
      expect(heatmap?.itemStyle?.borderRadius).toBe(2);
    } finally {
      getComputedStyleSpy.mockRestore();
      vi.doUnmock('../src/ui/echartsRegistry.ts');
    }
  });
});
