import { describe, expect, it } from 'vitest';
import { resolveSolarUsageCardProps } from '../src/ui/solarUsageSection.ts';
import { renderSolarUsageCard } from '../src/ui/views/SolarUsageCard.tsx';

// Card-state matrix: REAL producer (`resolveSolarUsageCardProps`) feeding the
// REAL Preact view into jsdom — full money / avoided+hint / kWh-only /
// export-only / gathering / hidden.

const OSLO = 'Europe/Oslo';
const HOUR_MS = 60 * 60 * 1000;
const TODAY_KEY = '2026-06-15';
const H0 = Date.UTC(2026, 5, 15, 10, 0, 0); // 12:00 local Oslo
const iso = (ms: number) => new Date(ms).toISOString();

const solarTracker = {
  generationBuckets: { [iso(H0)]: 2, [iso(H0 - 24 * HOUR_MS)]: 3 },
  exportBuckets: { [iso(H0)]: 0.5, [iso(H0 - 24 * HOUR_MS)]: 1 },
};

const pricesBoth = [
  { startsAt: iso(H0), total: 100, exportPrice: 40 },
  { startsAt: iso(H0 - 24 * HOUR_MS), total: 100, exportPrice: 40 },
];

const resolveProps = (overrides: Partial<Parameters<typeof resolveSolarUsageCardProps>[0]> = {}) => (
  resolveSolarUsageCardProps({
    tracker: solarTracker,
    combined: pricesBoth,
    timeZone: OSLO,
    todayKey: TODAY_KEY,
    hasManagedSolarDevice: true,
    ...overrides,
  })
);

const renderToContainer = (props: ReturnType<typeof resolveProps>) => {
  const container = document.createElement('div');
  renderSolarUsageCard(container, props);
  return container;
};

// Production measured, export never recorded — the state every flow install
// whose Flow predates signed watts lands in on upgrade.
const productionOnlyTracker = {
  generationBuckets: { [iso(H0)]: 2, [iso(H0 - 24 * HOUR_MS)]: 3 },
  exportBuckets: {},
};

describe('resolveSolarUsageCardProps + SolarUsageCard', () => {
  describe('no export ever measured', () => {
    it('keeps the numbers but qualifies them with a source-neutral note', () => {
      // Deliberately NOT hidden. With no export observed, "Used at home" IS
      // everything produced, so the arithmetic is honest for the data PELS
      // holds — and the shortfall, if there is one, is a configuration the
      // owner can fix. A blank space would say neither.
      const props = resolveProps({ tracker: productionOnlyTracker });
      expect(props?.layout).toBe('full');
      expect(props?.showNoExportMeasuredNote).toBe(true);

      const container = renderToContainer(props);
      const note = container.querySelector('#solar-usage-no-export');
      expect(note?.textContent).toContain('No export measured');
      // Source-neutral: the render gate is source-blind, so a zero-export
      // inverter on the Power meter source lands here honestly and must not be
      // told to reconfigure a Flow card it does not use.
      expect(note?.textContent).toContain('turns negative');
      expect(note?.textContent).not.toContain('Flow card');
      expect(container.textContent).toContain('Used at home');
    });

    it('renders the note above the money block it qualifies', () => {
      // It caveats both "Used at home · 100%" and the avoided figure derived
      // from that same self-use pool. Below the history rows it would be read
      // last at 320 px, or not at all.
      const container = renderToContainer(resolveProps({ tracker: productionOnlyTracker }));
      const note = container.querySelector('#solar-usage-no-export');
      const money = container.querySelector('#solar-usage-money');
      expect(note).not.toBeNull();
      expect(money).not.toBeNull();
      expect(note!.compareDocumentPosition(money!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('drops the note once ANY export is on record, below the materiality floor', () => {
      // The note is about whether net has EVER gone negative — proof the feed
      // can express export at all — not about how much. That is a different
      // question from `hasMaterialExhibitedExport`'s 1 kWh gate.
      const props = resolveProps({
        tracker: { ...productionOnlyTracker, exportBuckets: { [iso(H0)]: 0.02 } },
      });
      expect(props?.showNoExportMeasuredNote).toBe(false);
      expect(renderToContainer(props).querySelector('#solar-usage-no-export')).toBeNull();
    });

    it('stays off the export-only layout, which has export by definition', () => {
      const props = resolveProps({
        tracker: { generationBuckets: {}, exportBuckets: { [iso(H0)]: 2 } },
      });
      expect(props?.layout).toBe('export-only');
      expect(props?.showNoExportMeasuredNote).toBe(false);
    });
  });

  it('full money tier: today metrics, avoided + earned lines, previous-days grid', () => {
    const props = resolveProps();
    expect(props?.layout).toBe('full');
    expect(props?.today?.generatedKWh).toBe(2);
    expect(props?.money).toEqual({
      // selfUsed 1.5 × 100 øre = 150 øre ≈ 1.50 kr
      avoidedValueText: '≈ 1.50 kr',
      // exported 0.5 × 40 øre = 20 øre ≈ 0.20 kr
      earnedValueText: '≈ 0.20 kr',
      showExportPriceHint: false,
    });
    const container = renderToContainer(props);
    const text = container.textContent ?? '';
    expect(text).toContain('Solar');
    expect(text).toContain('Produced');
    expect(text).toContain('2.0 kWh');
    expect(text).toContain('Used at home');
    expect(text).toContain('75%');
    expect(text).toContain('Exported');
    // Money block is today-scoped on the labels themselves.
    expect(text).toContain('Grid cost avoided today');
    expect(text).toContain('Earned from export today');
    // History block: honest heading + a single header row labelling columns.
    expect(text).toContain('Previous days');
    expect(text).not.toContain('Last 7 days');
    const history = container.querySelector('#solar-usage-history');
    expect(history).not.toBeNull();
    const headerCells = [...history!.querySelectorAll('.metric-label')].map((cell) => cell.textContent);
    expect(headerCells).toEqual(['Day', 'Produced', 'At home', 'Exported']);
    // Data cells carry bare values — no per-row prose (the 320px blowout).
    expect(history!.textContent).not.toContain('used at home');
  });

  it('labels previous-day history rows day-first (never month-first)', () => {
    // Regression guard for the copy-sweep gap: the solar history rows resolved
    // their date through a default-locale formatter, so on an en-US host they
    // read month-first ("Jun 14"), inconsistent with the day-first grammar the
    // rest of the Usage tab pins. Routed through the shared
    // `formatDayFirstInTimeZone` — 2026-06-14 in Oslo reads "14 Jun".
    const props = resolveProps();
    expect(props?.history.length).toBeGreaterThan(0);
    const label = props!.history[0]!.label;
    expect(label).toContain('14 Jun');
    expect(label).not.toContain('Jun 14');
  });

  it('avoided-only tier (import prices without export price) shows the export-price hint', () => {
    const props = resolveProps({
      combined: pricesBoth.map((row) => ({ startsAt: row.startsAt, total: row.total })),
    });
    expect(props?.money?.avoidedValueText).toBe('≈ 1.50 kr');
    expect(props?.money?.earnedValueText).toBeNull();
    expect(props?.money?.showExportPriceHint).toBe(true);
    const text = renderToContainer(props).textContent ?? '';
    expect(text).toContain('Grid cost avoided today');
    expect(text).not.toContain('Earned from export');
    expect(text).toContain('Add an export price under Settings → Electricity prices');
  });

  it('kWh-only tier: no prices → no money block', () => {
    const props = resolveProps({ combined: null });
    expect(props?.money).toBeNull();
    const container = renderToContainer(props);
    expect(container.querySelector('#solar-usage-money')).toBeNull();
    expect(container.textContent).toContain('Produced');
  });

  it('kWh-only tier: blank-unit price scheme degrades like the Budget money view', () => {
    const props = resolveProps({
      combined: { priceScheme: 'flow', priceUnit: 'price units', prices: pricesBoth },
    });
    expect(props?.money).toBeNull();
  });

  it('appends the unpriced-hours suffix INLINE to the money value it qualifies', () => {
    const props = resolveProps({
      tracker: {
        generationBuckets: { [iso(H0)]: 2, [iso(H0 + HOUR_MS)]: 1 },
      },
      combined: [{ startsAt: iso(H0), total: 100 }],
    });
    // 2 kWh self-used × 100 øre, with the H0+1 hour unpriced — the suffix
    // rides the value text, never a standalone middot-opening line.
    expect(props?.money?.avoidedValueText).toBe('≈ 2.00 kr · some hours unpriced');
    const container = renderToContainer(props);
    expect(container.textContent).toContain('· some hours unpriced');
    const noteParagraphs = [...container.querySelectorAll('.solar-money__note')]
      .map((node) => node.textContent ?? '');
    expect(noteParagraphs.some((note) => note.startsWith('·'))).toBe(false);
  });

  it('flags the earned line independently when only export-price coverage is partial', () => {
    const props = resolveProps({
      tracker: {
        generationBuckets: { [iso(H0)]: 2, [iso(H0 + HOUR_MS)]: 2 },
        exportBuckets: { [iso(H0)]: 1, [iso(H0 + HOUR_MS)]: 1 },
      },
      combined: [
        { startsAt: iso(H0), total: 100, exportPrice: 40 },
        { startsAt: iso(H0 + HOUR_MS), total: 100 },
      ],
    });
    expect(props?.money?.avoidedValueText).toBe('≈ 2.00 kr');
    expect(props?.money?.earnedValueText).toBe('≈ 0.40 kr · some hours unpriced');
  });

  it('export-only layout for a meter-only home: export observed, production unknown', () => {
    const props = resolveProps({
      tracker: { exportBuckets: { [iso(H0)]: 1.5 } },
      combined: null,
      hasManagedSolarDevice: false,
    });
    expect(props?.layout).toBe('export-only');
    const text = renderToContainer(props).textContent ?? '';
    expect(text).toContain('Exported');
    expect(text).not.toContain('Produced');
    expect(text).toContain('Your meter reports export only');
  });

  it('export-only with an export price shows earnings only', () => {
    const props = resolveProps({
      tracker: { exportBuckets: { [iso(H0)]: 1.5 } },
      hasManagedSolarDevice: false,
    });
    expect(props?.money).toEqual({
      avoidedValueText: null,
      // 1.5 × 40 øre = 60 øre ≈ 0.60 kr
      earnedValueText: '≈ 0.60 kr',
      showExportPriceHint: false,
    });
  });

  it('battery homes: exported above produced keeps honest numbers plus the explainer note', () => {
    const props = resolveProps({
      tracker: {
        generationBuckets: { [iso(H0)]: 1 },
        exportBuckets: { [iso(H0)]: 3 },
      },
      combined: null,
    });
    expect(props?.showBatteryExportNote).toBe(true);
    expect(props?.today?.exportedKWh).toBe(3);
    expect(props?.today?.generatedKWh).toBe(1);
    expect(renderToContainer(props).textContent)
      .toContain('Exported can be higher than produced');
  });

  it('battery homes: a pure-battery-export day (zero production that day) still gets the note', () => {
    const props = resolveProps({
      tracker: {
        // Production yesterday keeps the full layout; today exports from storage only.
        generationBuckets: { [iso(H0 - 24 * HOUR_MS)]: 3 },
        exportBuckets: { [iso(H0)]: 2 },
      },
      combined: null,
    });
    expect(props?.layout).toBe('full');
    expect(props?.showBatteryExportNote).toBe(true);
  });

  it('gathering state: tracked solar device with no accounting yet', () => {
    const props = resolveProps({ tracker: null });
    expect(props?.layout).toBe('gathering');
    const container = renderToContainer(props);
    expect(container.querySelector('#solar-usage-gathering')).not.toBeNull();
    expect(container.querySelector('.usage-metric-row')).toBeNull();
  });

  it('hidden: a non-solar home resolves null and the mount stays empty', () => {
    const props = resolveProps({ tracker: null, hasManagedSolarDevice: false });
    expect(props).toBeNull();
    const container = renderToContainer(props);
    expect(container.childElementCount).toBe(0);
  });

  it('hidden: junk-negative export noise below the materiality floor never conjures the card', () => {
    const props = resolveProps({
      tracker: { exportBuckets: { [iso(H0)]: 0.05 } },
      hasManagedSolarDevice: false,
    });
    expect(props).toBeNull();
  });
});
