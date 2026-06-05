import { installHomeyMock } from './helpers/homeyApiMock.ts';
import { SETTINGS_UI_POWER_PATH } from '../../contracts/src/settingsUiApi.ts';
import { buildComparablePlanReason } from '../../shared-domain/src/planReasonSemantics.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  delete (document as Document & { hidden?: boolean }).hidden;
});

describe('Redesign plan UI', () => {
  
  const setupPlanDom = () => {
    document.body.innerHTML = `
      <section id="overview-panel">
        <div id="plan-redesign-surface"></div>
      </section>
    `;
  };
  
  const DEFAULT_REASON = { code: 'status_ok', message: '' };
  
  const normalizePlanSnapshot = (plan: unknown): unknown => {
    if (!plan || typeof plan !== 'object') return plan;
    const snapshot = plan as { devices?: Array<Record<string, unknown>> };
    if (!Array.isArray(snapshot.devices)) return plan;
    return {
      ...snapshot,
      devices: snapshot.devices.map((device) => {
        if (typeof device.reason === 'string') {
          return { ...device, reason: buildComparablePlanReason(device.reason) };
        }
        if (device.reason && typeof device.reason === 'object') return device;
        return { ...device, reason: DEFAULT_REASON };
      }),
    };
  };
  
  const renderPlanSnapshot = async (plan: unknown) => {
    vi.resetModules();
    setupPlanDom();
    const { renderPlan } = await import('../src/ui/plan.ts');
    renderPlan(normalizePlanSnapshot(plan) as Parameters<typeof renderPlan>[0]);
  };
  
  const getFirstPlanCard = (): HTMLElement | null => (
    document.querySelector('[data-device-id]') as HTMLElement | null
  );
  
  const getReasonText = (deviceId: string): string | undefined => (
    (document.querySelector(`[data-device-id="${deviceId}"] .plan-card__reason`) as HTMLElement | null)
      ?.textContent
      ?.trim()
  );
  
  const getMetricText = (deviceId: string): string | undefined => (
    (document.querySelector(`[data-device-id="${deviceId}"] .plan-card__metric-label`) as HTMLElement | null)
      ?.textContent
      ?.trim()
  );
  
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (document as Document & { hidden?: boolean }).hidden;
  });
  
  describe('Overview plan UI', () => {
    it('renders the hero bars and priority-sorted cards', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 5.2,
          softLimitKw: 11,
          headroomKw: 5.8,
          hardCapLimitKw: 14,
          hardCapHeadroomKw: 3,
          controlledKw: 3.1,
          uncontrolledKw: 2.1,
          powerFreshnessState: 'fresh',
          usedKWh: 4.2,
          budgetKWh: 12,
          capacityHourBudgetKWh: 12,
          dailyBudgetHourKWh: 11,
          hourBudgetKWh: 11,
          softLimitSource: 'daily',
          minutesRemaining: 8,
        },
        devices: [
          { id: 'dev-2', name: 'Second', priority: 2, currentState: 'on', plannedState: 'keep' },
          { id: 'dev-1', name: 'First', priority: 1, currentState: 'off', plannedState: 'shed' },
        ],
      });

      // Power headline shows current total kW without repeating "now"
      const headlines = Array.from(document.querySelectorAll('.plan-hero .plan-hero__headline'))
        .map((el) => el.textContent?.trim());
      expect(headlines).toContain('5.2 kW');
      // Power bar support text shows managed and other load breakdown only
      const supportLines = Array.from(document.querySelectorAll('.plan-hero .plan-hero__energy-support'))
        .map((el) => el.textContent?.trim());
      expect(supportLines[0]).toContain('Managed 3.1 kW');
      expect(supportLines[0]).toContain('Background 2.1 kW');
      expect(supportLines).toHaveLength(1);
      expect((document.querySelector('.plan-hero .plan-hero__subline:not(.plan-hero__subline--muted)') as HTMLElement | null)
        ?.textContent?.trim()).toBe('Safe pace now 11.0 kW');
      // Energy section shows the explicit backend-provided hour budget, not legacy budget fields.
      expect(headlines.some((h) => h?.includes('4.2 of 11.0 kWh used'))).toBe(true);
      expect(document.querySelectorAll('.plan-hero .pels-meter-track')).toHaveLength(2);
      // Hero chip rail stays calm when on track + fresh: no chips at all.
      // Mode and price-level chips were demoted in PR9 (owner walk 2026-05-17).
      expect(document.querySelectorAll('.plan-hero .plan-chip')).toHaveLength(0);
      // No stale-data chip when power is fresh
      expect(document.querySelector('.plan-hero .plan-chip--alert')).toBeNull();
      // Priority rank chip removed in PR9 — list order already encodes priority.
      expect(document.querySelector('.plan-card__chips .plan-chip--rank')).toBeNull();

      const deviceNames = Array.from(document.querySelectorAll('.plan-card__title'))
        .map((el) => el.textContent?.trim());
      expect(deviceNames).toEqual(['First', 'Second']);
    });

    it('renders the budget-exempt "Always on" chip on device cards', async () => {
      await renderPlanSnapshot({
        meta: { totalKw: 0, softLimitKw: 5, headroomKw: 5 },
        devices: [
          {
            id: 'dev-always-on',
            name: 'Server rack',
            priority: 1,
            budgetExempt: true,
            currentState: 'on',
            plannedState: 'keep',
          },
        ],
      });
      expect(
        (document.querySelector('[data-device-id="dev-always-on"] .plan-chip--muted') as HTMLElement | null)
          ?.textContent?.trim(),
      ).toBe('Always on');
    });

    it('renders the hero info button with the kW-vs-kWh tooltip', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 1.2,
          softLimitKw: 6,
          headroomKw: 4.8,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 30,
        },
        devices: [],
      });
      const infoButton = document.querySelector('.plan-hero__info-button') as HTMLElement | null;
      expect(infoButton).not.toBeNull();
      expect(infoButton?.getAttribute('aria-label')).toBe('About this card');
      expect(infoButton?.getAttribute('data-tooltip')).toMatch(/kW is speed\. kWh is distance\./);
    });

    it('renders segmented power-bar fills for managed and background draw', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 5.0,
          softLimitKw: 8,
          headroomKw: 3.0,
          hardCapLimitKw: 10,
          hardCapHeadroomKw: 5.0,
          controlledKw: 3.0,
          uncontrolledKw: 2.0,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 30,
        },
        devices: [],
      });
      const segments = Array.from(document.querySelectorAll('.pels-meter-segments__seg'));
      expect(segments).toHaveLength(2);
      expect(segments[0]?.className).toContain('pels-meter-segments__seg--managed');
      expect(segments[1]?.className).toContain('pels-meter-segments__seg--background');
    });

    it('writes the spec decision sentence when nothing is being limited', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 1.2,
          softLimitKw: 6,
          headroomKw: 4.8,
          hardCapLimitKw: 8,
          hardCapHeadroomKw: 6.8,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 38,
        },
        devices: [],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('Quiet hour. Nothing to do.');
    });

    it('writes the hard-cap decision sentence when power is over the configured maximum', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 9.5,
          softLimitKw: 6,
          headroomKw: -3.5,
          hardCapLimitKw: 8,
          hardCapHeadroomKw: -1.5,
          controlledKw: 3.0,
          uncontrolledKw: 6.5,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 38,
        },
        devices: [
          { id: 'dev-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', stateKind: 'held' },
        ],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('Over the hard cap right now. Easing devices off.');
      // Breathing motion must run in the over-hard-cap case too — it's the
      // most-active limiting state and the gate should not freeze it.
      expect(document.querySelector('.pels-meter-segments__seg--managed[data-limiting]')).not.toBeNull();
    });

    it('tells the honest story over the cap when the managed cascade is exhausted and a control-off device breaches', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 5.6,
          softLimitKw: 4.5,
          headroomKw: -1.1,
          hardCapLimitKw: 5,
          hardCapHeadroomKw: -0.6,
          controlledKw: 2.4,
          uncontrolledKw: 3.2,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 38,
        },
        devices: [
          // Every controllable managed device is already held — no running
          // managed device left for PELS to ease off.
          { id: 'dev-held', name: 'Heater', currentState: 'off', plannedState: 'shed', stateKind: 'held' },
          // The remaining breach is a device with Power-limit control off, which
          // PELS cannot touch (controllable === false → Manual chip).
          {
            id: 'dev-uncontrolled',
            name: 'Sauna',
            currentState: 'on',
            controllable: false,
            measuredPowerKw: 2.9,
            reason: 'capacity control off',
          },
        ],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe(
          'Managed devices are already eased off. The remaining draw is from '
          + 'a device that has Power-limit control turned off. '
          + 'Turn its Power-limit control back on so PELS can ease it off.',
        );
    });

    it('keeps the default over-cap copy when the only control-off device is parked at 0 W', async () => {
      // A control-off device drawing nothing is not the source of the breach, so
      // the honest "remaining draw is from it" copy must not fire on it.
      await renderPlanSnapshot({
        meta: {
          totalKw: 5.6,
          softLimitKw: 4.5,
          headroomKw: -1.1,
          hardCapLimitKw: 5,
          hardCapHeadroomKw: -0.6,
          controlledKw: 2.4,
          uncontrolledKw: 3.2,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 38,
        },
        devices: [
          { id: 'dev-held', name: 'Heater', currentState: 'off', plannedState: 'shed', stateKind: 'held' },
          {
            id: 'dev-uncontrolled-off',
            name: 'Sauna',
            currentState: 'off',
            controllable: false,
            measuredPowerKw: 0,
            reason: 'capacity control off',
          },
        ],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('Over the hard cap right now. Easing devices off.');
    });

    it('keeps the default over-cap copy while a managed device is mid-shed but still drawing', async () => {
      // A controllable device selected for shedding (plannedState 'shed' → marked
      // 'held') that is still physically drawing means the cascade is NOT done —
      // PELS is mid-shed. The honest "already eased off" copy must not fire yet.
      await renderPlanSnapshot({
        meta: {
          totalKw: 5.6,
          softLimitKw: 4.5,
          headroomKw: -1.1,
          hardCapLimitKw: 5,
          hardCapHeadroomKw: -0.6,
          controlledKw: 2.4,
          uncontrolledKw: 3.2,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 38,
        },
        devices: [
          // Selected for shedding but the element hasn't settled — still drawing.
          {
            id: 'dev-shedding',
            name: 'Heater',
            currentState: 'on',
            plannedState: 'shed',
            stateKind: 'held',
            measuredPowerKw: 1.2,
          },
          {
            id: 'dev-uncontrolled',
            name: 'Sauna',
            currentState: 'on',
            controllable: false,
            measuredPowerKw: 2.9,
            reason: 'capacity control off',
          },
        ],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('Over the hard cap right now. Easing devices off.');
    });

    it('keeps the default over-cap copy for a pending shed that is on-like with no power measurement', async () => {
      // No per-device power in the snapshot: a controllable device selected for
      // shedding that is still `currentState: 'on'` must count as not-yet-settled
      // (fall back to on-like state when measurement is absent), so the honest
      // "already eased off" copy must not fire while the shed is in flight.
      await renderPlanSnapshot({
        meta: {
          totalKw: 5.6,
          softLimitKw: 4.5,
          headroomKw: -1.1,
          hardCapLimitKw: 5,
          hardCapHeadroomKw: -0.6,
          controlledKw: 2.4,
          uncontrolledKw: 3.2,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 38,
        },
        devices: [
          // plannedState shed + on, but no measuredPowerKw → on-like fallback.
          { id: 'dev-shedding', name: 'Heater', currentState: 'on', plannedState: 'shed', stateKind: 'held' },
          {
            id: 'dev-uncontrolled',
            name: 'Sauna',
            currentState: 'on',
            controllable: false,
            measuredPowerKw: 2.9,
            reason: 'capacity control off',
          },
        ],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('Over the hard cap right now. Easing devices off.');
    });

    it('writes the actively-limiting decision sentence when one device is held below safe pace', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 4.0,
          softLimitKw: 5,
          headroomKw: 1.0,
          hardCapLimitKw: 7,
          hardCapHeadroomKw: 3.0,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 30,
        },
        devices: [
          { id: 'dev-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', stateKind: 'held' },
        ],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('Holding back 1 device so the house stays under 5.0 kW.');
    });

    it('uses the same declarative voice when limiting above safe pace', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 7.0,
          softLimitKw: 5,
          headroomKw: -2.0,
          hardCapLimitKw: 10,
          hardCapHeadroomKw: 3.0,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 30,
        },
        devices: [
          { id: 'dev-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', stateKind: 'held' },
        ],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('Holding back 1 device so the house stays under 5.0 kW.');
    });

    it('reflects projected-over-budget in the decision sentence so it does not contradict the Above budget chip', async () => {
      await renderPlanSnapshot({
        meta: {
          // currentKw 4.5 × 30/60 = 2.25 → projected 5.05 kWh, above 4.5 budget
          totalKw: 4.5,
          softLimitKw: 6,
          headroomKw: 1.5,
          hardCapLimitKw: 8,
          hardCapHeadroomKw: 3.5,
          powerFreshnessState: 'fresh',
          usedKWh: 2.8,
          hourBudgetKWh: 4.5,
          minutesRemaining: 30,
        },
        devices: [],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('On pace to overshoot this hour’s energy budget.');
    });

    it('surfaces the "X kW above safe pace" subline when current power is above safe pace', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 6.5,
          softLimitKw: 5,
          headroomKw: -1.5,
          hardCapLimitKw: 8,
          hardCapHeadroomKw: 1.5,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 30,
        },
        devices: [],
      });
      const subline = document.querySelector('.plan-hero .plan-hero__subline') as HTMLElement | null;
      expect(subline?.textContent?.trim()).toBe('1.5 kW above safe pace (5.0 kW)');
    });

    it('surfaces the "X kW above hard cap (Y kW)" subline when current power is above hard cap', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 8.5,
          softLimitKw: 5,
          headroomKw: -3.5,
          hardCapLimitKw: 8,
          hardCapHeadroomKw: -0.5,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 30,
        },
        devices: [],
      });
      const subline = document.querySelector('.plan-hero .plan-hero__subline') as HTMLElement | null;
      expect(subline?.textContent?.trim()).toBe('0.5 kW above hard cap (8.0 kW)');
    });

    it('labels every hero meter marker with aria-label and a legend when more than one marker is present', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 5.2,
          softLimitKw: 11,
          headroomKw: 5.8,
          hardCapLimitKw: 14,
          hardCapHeadroomKw: 3,
          controlledKw: 3.1,
          uncontrolledKw: 2.1,
          powerFreshnessState: 'fresh',
          usedKWh: 4.2,
          hourBudgetKWh: 11,
          minutesRemaining: 30,
        },
        devices: [],
      });

      const sections = Array.from(document.querySelectorAll('.plan-hero .plan-hero__section')) as HTMLElement[];
      expect(sections).toHaveLength(2);

      // Power bar has two markers: safe pace + hard cap. Both labeled.
      const powerMarkers = Array.from(sections[0]!.querySelectorAll('.pels-meter-track__marker')) as HTMLElement[];
      expect(powerMarkers).toHaveLength(2);
      expect(powerMarkers.map((m) => m.getAttribute('aria-label'))).toEqual([
        'Safe pace now 11.0 kW',
        'Hard cap 14.0 kW',
      ]);
      expect(powerMarkers.every((m) => m.getAttribute('role') === 'img')).toBe(true);

      // Energy bar has two markers: budget + projected end. Both labeled.
      const energyMarkers = Array.from(sections[1]!.querySelectorAll('.pels-meter-track__marker')) as HTMLElement[];
      expect(energyMarkers).toHaveLength(2);
      expect(energyMarkers.map((m) => m.getAttribute('aria-label'))).toEqual([
        'Budget this hour 11.0 kWh',
        expect.stringMatching(/^Projected this hour [\d.]+ kWh$/),
      ]);

      // Each bar with more than one marker renders a sublegend row.
      const legends = Array.from(document.querySelectorAll('.plan-hero__legend')) as HTMLElement[];
      expect(legends).toHaveLength(2);
      const legendLabels = legends.map((l) => Array.from(l.querySelectorAll('.plan-hero__legend-label'))
        .map((el) => el.textContent?.trim()));
      expect(legendLabels[0]).toEqual(['Safe pace', 'Hard cap']);
      expect(legendLabels[1]).toEqual(['Budget this hour', 'Projected this hour']);
    });

    it('renders a legend for a single-marker meter so the lone marker is self-explanatory', async () => {
      // No hard cap above safe pace -> the power bar carries ONLY the safe-pace
      // marker. A marker's meaning otherwise lives only in a hover tooltip
      // (non-discoverable on touch) + aria-label, so a single-marker bar must
      // still render a visible legend (progress-markers follow-up).
      await renderPlanSnapshot({
        meta: {
          totalKw: 1.5,
          softLimitKw: 2.3,
          headroomKw: 0.8,
          controlledKw: 1.0,
          uncontrolledKw: 0.5,
          powerFreshnessState: 'fresh',
          usedKWh: 0.3,
          hourBudgetKWh: 4.5,
          minutesRemaining: 40,
        },
        devices: [],
      });

      const sections = Array.from(document.querySelectorAll('.plan-hero .plan-hero__section')) as HTMLElement[];
      const powerMarkers = Array.from(sections[0]!.querySelectorAll('.pels-meter-track__marker')) as HTMLElement[];
      expect(powerMarkers, 'power bar carries only the safe-pace marker (no hard cap)').toHaveLength(1);
      const powerLegend = sections[0]!.querySelector('.plan-hero__legend');
      expect(powerLegend, 'single-marker power bar still renders a legend').not.toBeNull();
      const labels = Array.from(powerLegend!.querySelectorAll('.plan-hero__legend-label')).map((el) => el.textContent?.trim());
      expect(labels).toEqual(['Safe pace']);
    });

    it('uses only the explicit backend hour budget for the energy hero', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 0.6,
          softLimitKw: 4.5,
          headroomKw: 3.9,
          usedKWh: 0.02,
          budgetKWh: 9.5,
          capacityHourBudgetKWh: 9.5,
          capacityLimitKw: 5,
          dailyBudgetHourKWh: 12,
          hourBudgetKWh: 4.5,
          minutesRemaining: 58,
        },
        devices: [],
      });

      const headlines = Array.from(document.querySelectorAll('.plan-hero .plan-hero__headline'))
        .map((el) => el.textContent?.trim());
      expect(headlines.some((h) => h?.includes('0.0 of 4.5 kWh used'))).toBe(true);
      expect(headlines.some((h) => h?.includes('0.0 of 5.0 kWh used'))).toBe(false);
      expect(headlines.some((h) => h?.includes('0.0 of 9.5 kWh used'))).toBe(false);
      expect(headlines.some((h) => h?.includes('0.0 of 12.0 kWh used'))).toBe(false);
    });

    it('does not fall back to legacy hour budget fields in the hero', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 0.6,
          softLimitKw: 4.5,
          headroomKw: 3.9,
          usedKWh: 0.02,
          budgetKWh: 9.5,
          capacityHourBudgetKWh: 4.5,
          capacityLimitKw: 5,
          dailyBudgetHourKWh: 12,
          minutesRemaining: 58,
        },
        devices: [],
      });

      const headlines = Array.from(document.querySelectorAll('.plan-hero .plan-hero__headline'))
        .map((el) => el.textContent?.trim());
      expect(headlines).toEqual(['0.6 kW']);
    });
  
    it('renders three-row cards with state chip, load bar, and real reason text', async () => {
      await renderPlanSnapshot({
        meta: { totalKw: 2.2, softLimitKw: 6, headroomKw: 3.8 },
        devices: [
          {
            id: 'dev-heat',
            name: 'Living Room Heat Pump',
            currentState: 'on',
            plannedState: 'keep',
            expectedPowerKw: 1.6,
            measuredPowerKw: 1.2,
            reason: {
              code: 'restore_need',
              fromTarget: '21°',
              toTarget: '22°',
              needKw: 0.4,
              headroomKw: 2.1,
            },
            stateKind: 'active',
            stateTone: 'active',
          },
        ],
      });
  
      const card = getFirstPlanCard();
      expect(
        card?.querySelectorAll(':scope > *:not(md-elevation):not(md-ripple)'),
      ).toHaveLength(3);
      expect((card?.querySelector('.plan-state-chip-wrap .plan-chip') as HTMLElement | null)?.textContent?.trim()).toBe('Running');
      expect(getMetricText('dev-heat')).toBe('1.2 kW');
      expect(getReasonText('dev-heat')).toBe('Raising target 21° to 22°');
      expect(card?.querySelector('.plan-card__metric--power')).toBeTruthy();
    });
  
    it('prefers structured state presentation from the snapshot payload', async () => {
      await renderPlanSnapshot({
        meta: { totalKw: 0, softLimitKw: 5, headroomKw: 5 },
        devices: [
          {
            id: 'dev-held',
            name: 'Water Heater',
            currentState: 'off',
            plannedState: 'shed',
            stateKind: 'held',
            stateTone: 'held',
          },
        ],
      });
  
      const chip = document.querySelector('[data-device-id="dev-held"] .plan-state-chip-wrap .plan-chip') as HTMLElement | null;
      expect(chip).toBeNull();
      // Safe pace subline shown when devices are held
      const subline = document.querySelector('.plan-hero .plan-hero__subline') as HTMLElement | null;
      expect(subline?.textContent?.trim()).toBe('Safe pace now 5.0 kW');
    });
  
    it('surfaces starvation badges and overrides the reason line for capacity starvation', async () => {
      await renderPlanSnapshot({
        meta: { totalKw: 4.2, softLimitKw: 5, headroomKw: 0.8 },
        devices: [
          {
            id: 'dev-starved',
            name: 'Bathroom Floor',
            currentState: 'off',
            plannedState: 'shed',
            starvation: {
              isStarved: true,
              accumulatedMs: 23 * 60 * 1000,
              cause: 'capacity',
              startedAtMs: Date.UTC(2026, 3, 20, 11, 0, 0),
            },
          },
        ],
      });
  
      const badgeTexts = Array.from(document.querySelectorAll('[data-device-id="dev-starved"] .plan-chip'))
        .map((el) => el.textContent?.trim());
      expect(badgeTexts).toContain('Low power');
      expect(getReasonText('dev-starved')).toBe('Waiting for available power');
      // Starvation summary is shown on device card, not in hero
    });
  
    it('updates countdown-based reasons during live ticks', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));
      await renderPlanSnapshot({
        generatedAtMs: Date.now(),
        meta: {
          totalKw: 2.2,
          softLimitKw: 6,
          headroomKw: 3.8,
          lastPowerUpdateMs: Date.now(),
        },
        devices: [
          {
            id: 'dev-cooldown',
            name: 'EV Charger',
            currentState: 'off',
            plannedState: 'keep',
            reason: { code: 'meter_settling', remainingSec: 10 },
          },
        ],
      });
  
      const timer = document.querySelector(
        '[data-device-id="dev-cooldown"] .plan-state-chip__timer',
      ) as (HTMLElement & { value?: number }) | null;
      expect(timer?.hidden).toBe(false);
      expect(timer?.value).toBeCloseTo(1, 2);

      vi.advanceTimersByTime(4_000);
      await Promise.resolve();

      expect(timer?.value).toBeCloseTo(0.6, 2);
    });

    it('stops presenting expired cooldown reasons as active', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));
      await renderPlanSnapshot({
        generatedAtMs: Date.now(),
        meta: {
          totalKw: 2.2,
          softLimitKw: 6,
          headroomKw: 3.8,
        },
        devices: [
          {
            id: 'dev-restore-cooldown',
            name: 'Heat Pump',
            currentState: 'off',
            plannedState: 'keep',
            reason: { code: 'cooldown_restore', remainingSec: 1 },
          },
        ],
      });

      const timer = document.querySelector(
        '[data-device-id="dev-restore-cooldown"] .plan-state-chip__timer',
      ) as (HTMLElement & { value?: number }) | null;
      expect(getReasonText('dev-restore-cooldown')).toBe('Waiting before resuming (1s)');
      expect(timer?.hidden).toBe(false);
      // Cooldown summary is shown on device card, not as a hero chip

      vi.advanceTimersByTime(1_000);
      await Promise.resolve();

      expect(getReasonText('dev-restore-cooldown')).toBeFalsy();
      const expiredTimer = document.querySelector(
        '[data-device-id="dev-restore-cooldown"] .plan-state-chip__timer',
      ) as HTMLElement | null;
      expect(expiredTimer === null || expiredTimer.hidden).toBe(true);
    });

    it('does not show an already-expired cooldown timer on initial render', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-20T12:00:02Z'));
      await renderPlanSnapshot({
        generatedAtMs: Date.parse('2026-04-20T12:00:00Z'),
        meta: {
          totalKw: 2.2,
          softLimitKw: 6,
          headroomKw: 3.8,
        },
        devices: [
          {
            id: 'dev-expired-cooldown',
            name: 'Already Cool',
            currentState: 'off',
            plannedState: 'keep',
            reason: { code: 'cooldown_restore', remainingSec: 1 },
          },
        ],
      });

      const timer = document.querySelector(
        '[data-device-id="dev-expired-cooldown"] .plan-state-chip__timer',
      ) as HTMLElement | null;
      expect(getReasonText('dev-expired-cooldown')).toBeFalsy();
      expect(timer === null || timer.hidden).toBe(true);
      // Cooldown summary lives on device card, not as a hero chip
    });
  
    it('dims idle devices and marks missing devices unavailable via state kind', async () => {
      await renderPlanSnapshot({
        meta: { totalKw: 0, softLimitKw: 5, headroomKw: 5 },
        devices: [
          { id: 'idle', name: 'Idle device', currentState: 'off', plannedState: 'inactive', stateKind: 'idle' },
          { id: 'missing', name: 'Missing device', currentState: 'unknown', plannedState: 'keep', stateKind: 'unavailable' },
        ],
      });
  
      expect(document.querySelector('[data-device-id="idle"]')?.className).toContain('plan-card--dim');
      expect(document.querySelector('[data-device-id="missing"]')?.getAttribute('data-state-kind')).toBe('unavailable');
    });
  
    it('opens device details on click and keyboard activation', async () => {
      const detailEvents: string[] = [];
      document.addEventListener('open-device-detail', ((event: Event) => {
        detailEvents.push((event as CustomEvent<{ deviceId: string }>).detail.deviceId);
      }) as EventListener);
  
      await renderPlanSnapshot({
        meta: { totalKw: 0, softLimitKw: 5, headroomKw: 5 },
        devices: [{ id: 'dev-open', name: 'Overview Device', currentState: 'on', plannedState: 'keep' }],
      });
  
      const row = document.querySelector('[data-device-id="dev-open"]') as HTMLElement;
      row.click();
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      row.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
  
      expect(detailEvents).toEqual(['dev-open', 'dev-open', 'dev-open']);
      expect(row.getAttribute('aria-label')).toBe('Open device details for Overview Device');
    });
  
    it('shows empty states for missing plans and missing devices', async () => {
      await renderPlanSnapshot(null);
      expect((document.querySelector('#plan-empty') as HTMLElement | null)?.textContent)
        .toContain('No plan available yet');
  
      await renderPlanSnapshot({
        meta: { totalKw: 0, softLimitKw: 5, headroomKw: 5 },
        devices: [],
      });
      expect((document.querySelector('#plan-empty') as HTMLElement | null)?.textContent)
        .toContain('No managed devices');
    });

    it('clears previously rendered cards when the plan later becomes unavailable', async () => {
      vi.resetModules();
      setupPlanDom();
      const { renderPlan } = await import('../src/ui/plan.ts');

      renderPlan(normalizePlanSnapshot({
        meta: { totalKw: 2.2, softLimitKw: 6, headroomKw: 3.8 },
        devices: [{ id: 'dev-clear', name: 'Device to clear', currentState: 'on', plannedState: 'keep' }],
      }) as Parameters<typeof renderPlan>[0]);

      expect(document.querySelector('[data-device-id="dev-clear"]')).not.toBeNull();

      renderPlan(null);

      expect(document.querySelector('[data-device-id="dev-clear"]')).toBeNull();
      expect((document.querySelector('#plan-empty') as HTMLElement | null)?.textContent)
        .toContain('No plan available yet');
    });

    it('refreshes the plan when the power endpoint fails', async () => {
      vi.resetModules();
      setupPlanDom();
      const homey = installHomeyMock({
        uiState: {
          plan: normalizePlanSnapshot({
            meta: { totalKw: 2.2, softLimitKw: 6, headroomKw: 3.8 },
            devices: [{ id: 'dev-refresh', name: 'Refreshed device', currentState: 'on', plannedState: 'keep' }],
          }),
        },
        apiHandlers: {
          [`GET ${SETTINGS_UI_POWER_PATH}`]: async () => {
            throw new Error('power unavailable');
          },
        },
      });
      const { setHomeyClient } = await import('../src/ui/homey.ts');
      const { refreshPlan } = await import('../src/ui/plan.ts');
      setHomeyClient(homey);

      await refreshPlan();

      expect(document.querySelector('[data-device-id="dev-refresh"]')).not.toBeNull();
      expect((document.querySelector('.plan-card__title') as HTMLElement | null)?.textContent?.trim())
        .toBe('Refreshed device');
    });

    it('uses plan freshness when a cached power status is stale and the power endpoint fails', async () => {
      vi.resetModules();
      setupPlanDom();
      const homey = installHomeyMock({
        uiState: {
          plan: normalizePlanSnapshot({
            meta: {
              totalKw: 2.2,
              softLimitKw: 6,
              headroomKw: 3.8,
              powerFreshnessState: 'stale_fail_closed',
            },
            devices: [],
          }),
        },
        apiHandlers: {
          [`GET ${SETTINGS_UI_POWER_PATH}`]: async () => {
            throw new Error('power unavailable');
          },
        },
      });
      const { setHomeyClient } = await import('../src/ui/homey.ts');
      const {
        refreshPlan,
        updatePlanPower,
      } = await import('../src/ui/plan.ts');
      setHomeyClient(homey);
      updatePlanPower({ powerFreshnessState: 'fresh' });

      await refreshPlan();

      expect((document.querySelector('.plan-hero .plan-chip') as HTMLElement | null)?.textContent?.trim())
        .toBe('No data');
    });
  });
});
