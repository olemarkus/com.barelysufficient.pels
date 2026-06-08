import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { renderBudgetOverview, type BudgetOverviewProps } from '../src/ui/views/BudgetOverview.tsx';
import { renderDeadlinesList } from '../src/ui/views/DeadlinesList.tsx';
import { DeadlineChip } from '../src/ui/views/PlanDeviceCards.tsx';
import { state } from '../src/ui/state.ts';
import { createEmptyDeferredObjectiveSettings } from '../../contracts/src/deferredObjectiveSettings.ts';

/* -------------------------------------------------------------------------- *
 * Chip primitive rebind regression tests.
 *
 * `.plan-chip` is the single canonical chip primitive across every settings-UI
 * surface — Overview status / freshness chips, Budget price-level chip, Usage
 * hero delta / day-status pills, Smart-task list status / kind / confidence
 * chips, deadline-plan hero chips, history-detail outcome / cost / shortfall
 * chips, device-list state chips, device-card managed-count chip. Tonal state
 * lives in either the BEM modifier (`.plan-chip--{good|warn|alert|info|muted|
 * limited}`) or the canonical data attribute (`data-tone="…"`) — both must
 * resolve onto the same `.plan-chip` shell so a future refactor cannot fork
 * the chip family back into the per-page near-duplicates this consolidation
 * retired.
 *
 * The legacy `.chip` primitive (with `chip--ok` / `chip--boost` / `chip--
 * neutral` / `chip--alert` tonal variants) was removed in this rebind; the
 * two remaining consumers (device-list state chip, mode-row priority badge)
 * rebound onto `.plan-chip plan-chip--muted` and the standalone
 * `.priority-badge` pill respectively. The CSS file should no longer declare
 * the legacy `.chip` shell; the source files should not reference it.
 *
 * These assertions are intentionally lightweight DOM / source-text checks so
 * the suite catches accidental regressions (someone reintroduces `.chip` /
 * spawns a new per-page chip class) without coupling to pixel output (that's
 * the screenshot suite's job).
 * -------------------------------------------------------------------------- */

const STYLE_CSS_PATH = path.join(__dirname, '..', 'public', 'style.css');
const STYLE_CSS = fs.readFileSync(STYLE_CSS_PATH, 'utf8');
const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const INDEX_HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const SETTINGS_UI_SRC = path.join(__dirname, '..', 'src');

const NOW_MS = Date.UTC(2026, 4, 24, 12, 0, 0);

const mountIntoBody = (): HTMLElement => {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return mount;
};

afterEach(() => {
  document.body.replaceChildren();
  state.deferredObjectiveSettings = createEmptyDeferredObjectiveSettings();
});

// Recursively collect every file in the settings-UI `src` tree so the
// "no legacy `.chip` className left in source" assertion can walk the whole
// surface. We exclude the build-output `dist/` directory and any non-TS/TSX
// files (image assets, copy fixtures, etc.).
const collectSourceFiles = (dir: string, acc: string[] = []): string[] => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach((entry) => {
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') return;
      collectSourceFiles(path.join(dir, entry.name), acc);
      return;
    }
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      acc.push(path.join(dir, entry.name));
    }
  });
  return acc;
};

// ─── Canonical `.plan-chip` primitive contract ───────────────────────────────

describe('chip primitive: canonical `.plan-chip` is the single source of truth', () => {
  it('declares both the BEM tonal modifiers AND the canonical data-tone selectors', () => {
    // Both APIs must resolve onto the same tonal style so the canonical
    // `data-tone` attribute can be used by new consumers without flipping
    // every existing modifier-class consumer in the same change.
    const expectedTones = ['good', 'warn', 'alert', 'info', 'muted', 'limited'];
    expectedTones.forEach((tone) => {
      const modifier = `.plan-chip--${tone}`;
      const dataTone = `.plan-chip[data-tone="${tone}"]`;
      expect(STYLE_CSS, `expected ${modifier} selector in style.css`).toContain(modifier);
      expect(STYLE_CSS, `expected ${dataTone} selector in style.css`).toContain(dataTone);
    });
  });

  it('ports the `.chip[data-tooltip]` help cursor over to `.plan-chip[data-tooltip]`', () => {
    // The device-list state chips (Unavailable / Budget exempt / Flow-backed)
    // rely on the help cursor as the tooltip discovery affordance. The
    // pre-consolidation `.chip[data-tooltip]` rule had that responsibility;
    // it must now ride on the canonical `.plan-chip` primitive.
    expect(STYLE_CSS).toMatch(/\.plan-chip\[data-tooltip\]\s*\{[^}]*cursor:\s*help/);
  });

  it('ports the `.chip strong` typography over to `.plan-chip strong`', () => {
    // Inline-numeric callouts inside a chip (e.g. legacy device-row callouts)
    // depended on the `.chip strong` cascade to bump weight + tighten
    // letter-spacing. The canonical primitive must keep that rule alive on
    // the new shell.
    expect(STYLE_CSS).toMatch(/\.plan-chip strong\s*\{/);
  });
});

// ─── Legacy `.chip` primitive removed ────────────────────────────────────────

describe('chip primitive: the legacy `.chip` primitive no longer exists', () => {
  it('does not declare the standalone `.chip` shell in style.css', () => {
    // Allow `.plan-chip`, `.plan-state-chip`, `.detail-mode-row__active-chip`,
    // `.plan-history-detail__…-chip`, `.pels-device-card__count-chip`, etc.
    // — only the bare `.chip` selector with no prefix should be banned.
    const lines = STYLE_CSS.split('\n');
    const offending = lines.filter((line) => /^\s*\.chip(\s*\{|,|\s+[a-z[])/.test(line));
    expect(offending, `unexpected legacy .chip selector(s):\n${offending.join('\n')}`).toHaveLength(0);
  });

  it('does not declare the legacy tonal variants (`chip--ok` / `--boost` / `--neutral` / `--alert`)', () => {
    // These tonal variants existed only on the retired primitive — never on
    // `.plan-chip`. Their reappearance would mean the legacy primitive has
    // been resurrected.
    const legacyTonalSelectors = [
      /^\s*\.chip--ok\b/m,
      /^\s*\.chip--boost\b/m,
      /^\s*\.chip--neutral\b/m,
      /^\s*\.chip--alert\b/m,
    ];
    legacyTonalSelectors.forEach((pattern) => {
      expect(STYLE_CSS).not.toMatch(pattern);
    });
  });

  it('does not reference the legacy `chip` / `chip--neutral` className in any source file', () => {
    // Bans plain `chip` (with word boundaries) inside a className-style
    // string literal. Allow chip-suffixed BEM classes (`*-chip` /
    // `*__chip`) and the canonical `plan-chip` / hyphenated variants.
    const sourceFiles = collectSourceFiles(SETTINGS_UI_SRC);
    const offending: string[] = [];
    sourceFiles.forEach((file) => {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        // Skip comments.
        const stripped = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
        // Look for bare `chip` or `chip--{ok|boost|neutral|alert}` inside a
        // className-style string literal (single or double quote, or backtick).
        if (/['"`](?:[^'"`]*\s)?chip(?:--(?:ok|boost|neutral|alert))?(?:\s[^'"`]*)?['"`]/.test(stripped)) {
          offending.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    });
    expect(
      offending,
      `legacy .chip / .chip--* className still referenced:\n${offending.join('\n')}`,
    ).toHaveLength(0);
  });
});

// ─── Per-surface chip rebind ─────────────────────────────────────────────────

describe('chip primitive: every surface walks the canonical `.plan-chip`', () => {
  it('index.html usage-hero delta + day-status pills carry `.plan-chip`', () => {
    const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
    const heroDelta = doc.querySelector('#usage-hero-delta');
    expect(heroDelta?.classList.contains('plan-chip')).toBe(true);
    expect(heroDelta?.classList.contains('plan-chip--muted')).toBe(true);
    const dayStatus = doc.querySelector('#usage-day-status-pill');
    expect(dayStatus?.classList.contains('plan-chip')).toBe(true);
    expect(dayStatus?.classList.contains('plan-chip--muted')).toBe(true);
  });

  it('Budget header price-level chip carries `.plan-chip` (no bare `.chip`)', () => {
    const mount = mountIntoBody();
    renderBudgetOverview(mount, buildBudgetProps({
      priceLevelChip: { label: 'Price low', tone: 'info', priceLevel: 'CHEAP' },
    }));
    const header = mount.querySelector('header.plan-hero.pels-hero');
    const chip = header?.querySelector('.plan-hero__chip-rail .plan-chip');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('Price low');
    // The same chip slot must NOT also carry the legacy `.chip` class — that
    // would reintroduce the duplicate primitive cascade.
    expect(chip?.classList.contains('chip')).toBe(false);
  });

  it('Smart-task list cards mount chips through `.plan-chip` (kind, status, confidence)', () => {
    const mount = mountIntoBody();
    const T0 = Date.UTC(2026, 4, 16, 6, 50, 0);
    renderDeadlinesList(mount, {
      status: 'ready',
      cards: [{
        deviceId: 'dev_water_heater',
        deviceName: 'Connected 300',
        kind: 'temperature',
        targetValue: 65,
        firstActionAtMs: T0,
        deadlineAtMs: T0 + 6 * 3_600_000,
        href: './?page=deadline-plan&deviceId=dev_water_heater',
        statusId: 'on_track',
        confidence: null,
        learning: false,
        extraPermissionsValue: null,
        currentValueLine: null,
      }],
    });
    const chips = mount.querySelectorAll('.deadline-list-card__header .plan-chip');
    // At minimum: kind + status chips render. Confidence chip is optional.
    expect(chips.length).toBeGreaterThanOrEqual(2);
    chips.forEach((chip) => {
      expect(chip.classList.contains('chip')).toBe(false);
    });
  });

  it('DeadlineChip link variant carries `.plan-chip.plan-chip--info.plan-chip--link`', () => {
    state.deferredObjectiveSettings = {
      version: 1,
      objectivesByDeviceId: {
        'connected-300': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 65,
          deadlineAtMs: NOW_MS + 6 * 60 * 60 * 1000,
        },
      },
    };
    const mount = document.createElement('div');
    render(h(DeadlineChip, { deviceId: 'connected-300', nowMs: NOW_MS }), mount);
    const link = mount.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.classList.contains('plan-chip')).toBe(true);
    expect(link?.classList.contains('plan-chip--info')).toBe(true);
    expect(link?.classList.contains('plan-chip--link')).toBe(true);
    // Tooltip-cursor opt-in is wired by the canonical primitive via
    // `.plan-chip[data-tooltip]` — assert the data-attribute is present so
    // the cursor rule actually applies.
    expect(link?.getAttribute('data-tooltip')).toBe('Open smart task');
  });

  it('device-list state chip rebinds to `.plan-chip plan-chip--muted` with `data-tone="muted"`', async () => {
    vi.resetModules();
    vi.doMock('../src/ui/modes.ts', () => ({ renderPriorities: vi.fn() }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/plan.ts', () => ({ refreshPlan: vi.fn() }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToast: vi.fn().mockResolvedValue(undefined),
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
      logSettingsWarn: vi.fn().mockResolvedValue(undefined),
    }));

    const setupListDom = () => {
      const root = document.body;
      root.replaceChildren();
      const deviceListEl = document.createElement('div');
      deviceListEl.id = 'device-list';
      const cardListEl = document.createElement('div');
      cardListEl.id = 'device-card-list';
      const emptyStateEl = document.createElement('p');
      emptyStateEl.id = 'empty-state';
      const refreshBtn = document.createElement('button');
      refreshBtn.id = 'refresh-button';
      root.append(deviceListEl, cardListEl, emptyStateEl, refreshBtn);
    };
    setupListDom();
    const { renderDevices } = await import('../src/ui/devices.ts');
    const { state: importedState } = await import('../src/ui/state.ts');
    importedState.initialLoadComplete = true;
    importedState.latestDevices = [{
      id: 'dev-unavailable',
      name: 'Unavailable Device',
      targets: [],
      deviceType: 'temperature',
      binaryControl: { on: true },
      available: false,
    } as unknown as Parameters<typeof renderDevices>[0][number]];
    importedState.budgetExemptMap = {};

    renderDevices(importedState.latestDevices);

    const stateChip = document.querySelector('.device-row__state-chip') as HTMLElement | null;
    expect(stateChip).not.toBeNull();
    expect(stateChip?.classList.contains('plan-chip')).toBe(true);
    expect(stateChip?.classList.contains('plan-chip--muted')).toBe(true);
    expect(stateChip?.classList.contains('chip')).toBe(false);
    expect(stateChip?.dataset.tone).toBe('muted');
  });
});

// ─── Stub props for BudgetOverview ───────────────────────────────────────────

const buildBudgetProps = (overrides: Partial<BudgetOverviewProps> = {}): BudgetOverviewProps => ({
  localView: 'plan',
  view: 'today',
  hero: {
    headlineLabel: null,
    comparison: 'Daily budget off',
    delta: null,
    budgetRemainingLine: null,
    splitLine: null,
    priceTagline: null,
    decision: null,
    heroTone: 'ok',
  },
  chart: null,
  confidence: null,
  adjust: {
    draft: { enabled: false, dailyBudgetKWh: 60, priceShaping: false, controlledWeight: 0, priceFlexShare: 0.6 },
    active: { enabled: false, dailyBudgetKWh: 60, priceShaping: false, controlledWeight: 0, priceFlexShare: 0.6 },
    candidate: null,
    activeChart: null,
    candidateChart: null,
    comparisonDayView: 'today',
    comparisonDayLabel: 'Today',
    comparisonShowPrice: false,
    status: 'clean',
    busy: false,
    hardCapKw: 12,
    safetyMarginKw: 1,
  },
  allocationWarning: null,
  priceLevelChip: null,
  onLocalViewChange: () => {},
  onDayChange: () => {},
  onChartModeChange: () => {},
  onAdjustFieldChange: () => {},
  onPreview: () => {},
  onApply: () => {},
  onDiscard: () => {},
  ...overrides,
});
