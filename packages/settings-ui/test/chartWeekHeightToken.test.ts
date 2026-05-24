import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/* -------------------------------------------------------------------------- *
 * Power-week chart height token promotion regression.
 *
 * Before this rebind the power-week chart height lived as two parallel
 * literals (`height: 240px; min-height: 240px;` in `.power-week-chart`
 * + `const DEFAULT_CHART_HEIGHT = 240` in `powerWeekChartEcharts.ts`),
 * which meant any future change to the chart footprint would have had to
 * touch two files and could silently drift — the container box and the
 * ECharts SVG viewport would have diverged. Promoting to
 * `--pels-chart-week-height` gives the chart sizing contract a single
 * chart-scoped source of truth.
 *
 * These assertions lock the contract end-to-end:
 *   1. `tokens.css` defines `--pels-chart-week-height` (style-dictionary
 *      output from `tokens/component.json`).
 *   2. `.power-week-chart` consumes `var(--pels-chart-week-height)` for
 *      both `height` and `min-height` in `public/style.css`.
 *   3. `resolveChartHeight` in `powerWeekChartEcharts.ts` reads the same
 *      `--pels-chart-week-height` custom property at runtime and parses
 *      the px value (verified via the size passed to `chart.resize`).
 * -------------------------------------------------------------------------- */

const STYLE_CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');
const TOKENS_CSS_PATH = path.join(__dirname, '..', 'dist', 'tokens.css');

describe('power-week chart height token (--pels-chart-week-height)', () => {
  it('is declared in the generated tokens.css', () => {
    const tokensCss = fs.readFileSync(TOKENS_CSS_PATH, 'utf8');
    // The token is a literal `240px` (chart heights are physical, not
    // theme-relative), so we lock the LHS declaration AND the resolved px.
    expect(tokensCss).toMatch(/--pels-chart-week-height:\s*240px\s*;/);
  });

  it('powers .power-week-chart height + min-height in public/style.css', () => {
    const styleCss = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
    const rule = styleCss.match(/\.power-week-chart\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0] ?? '').toMatch(
      /height:\s*var\(--pels-chart-week-height\)\s*;/,
    );
    expect(rule?.[0] ?? '').toMatch(
      /min-height:\s*var\(--pels-chart-week-height\)\s*;/,
    );
    // Defensive: ensure the rule is not still pinned to the 240px literal.
    expect(rule?.[0] ?? '').not.toMatch(/height:\s*240px/);
    expect(rule?.[0] ?? '').not.toMatch(/min-height:\s*240px/);
  });

  it('resolveChartHeight reads --pels-chart-week-height and parses the px value', async () => {
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
      if (variable === '--pels-chart-week-height') return '240px';
      return '';
    });
    const getComputedStyleSpy = vi
      .spyOn(globalThis, 'getComputedStyle')
      .mockReturnValue({ getPropertyValue } as unknown as CSSStyleDeclaration);

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
      const chart = lastInit?.value as {
        setOption: ReturnType<typeof vi.fn>;
        resize: ReturnType<typeof vi.fn>;
      };
      // The height ends up in two places: the `initEcharts` constructor
      // options and the subsequent `chart.resize` call. Both should consume
      // the parsed token value.
      const initCall = initEcharts.mock.calls[0] as unknown as
        | [HTMLElement, unknown, { height?: number; width?: number }]
        | undefined;
      expect(initCall?.[2]?.height).toBe(240);
      const resizeArg = chart.resize.mock.calls[0]?.[0] as { height?: number } | undefined;
      expect(resizeArg?.height).toBe(240);
      expect(getPropertyValue).toHaveBeenCalledWith('--pels-chart-week-height');
    } finally {
      getComputedStyleSpy.mockRestore();
      vi.doUnmock('../src/ui/echartsRegistry.ts');
    }
  });

  it('resolveChartHeight falls back to 240 when the token is missing', async () => {
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
      const chart = lastInit?.value as {
        setOption: ReturnType<typeof vi.fn>;
        resize: ReturnType<typeof vi.fn>;
      };
      // Fallback constant mirrors the token's literal source value (240 px).
      const initCall = initEcharts.mock.calls[0] as unknown as
        | [HTMLElement, unknown, { height?: number; width?: number }]
        | undefined;
      expect(initCall?.[2]?.height).toBe(240);
      const resizeArg = chart.resize.mock.calls[0]?.[0] as { height?: number } | undefined;
      expect(resizeArg?.height).toBe(240);
    } finally {
      getComputedStyleSpy.mockRestore();
      vi.doUnmock('../src/ui/echartsRegistry.ts');
    }
  });
});
