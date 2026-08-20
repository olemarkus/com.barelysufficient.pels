import { installHomeyMock } from './helpers/homeyApiMock.ts';
import { SETTINGS_UI_POWER_PATH } from '../../contracts/src/settingsUiApi.ts';
import { fixtureDeviceReason } from './helpers/fixtureDeviceReason.ts';
import { buildPlanMeta } from './helpers/planMetaFixture.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  // `Document.hidden` is non-optional in lib.dom, so intersecting an optional
  // `hidden?` still yields a required property and `delete` rejects it. Go
  // through `unknown` to the shape this teardown actually manipulates: a bag
  // carrying an optional override the tests stamp on and clear.
  delete (document as unknown as { hidden?: boolean }).hidden;
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
        const normalized = {
          ...device,
          controllable: device.controllable ?? true,
          available: device.available ?? true,
        };
        if (typeof device.reason === 'string') {
          return { ...normalized, reason: fixtureDeviceReason(device.reason) };
        }
        if (device.reason && typeof device.reason === 'object') return normalized;
        return { ...normalized, reason: DEFAULT_REASON };
      }),
    };
  };
  
  const renderPlanSnapshot = async (plan: unknown) => {
    vi.resetModules();
    setupPlanDom();
    const normalized = normalizePlanSnapshot(plan) as { devices?: Array<Record<string, unknown>> };
    // The Overview renders the DEVICE list joined to the plan, so a plan
    // fixture alone no longer draws cards. Seed the device payload these
    // fixtures imply: in production the device list is a superset of the plan's
    // devices, so mirroring the plan's ids is the faithful minimum.
    const { state } = await import('../src/ui/state.ts');
    state.latestDevices = (normalized.devices ?? []).map((device: Record<string, unknown>) => ({
      id: device.id,
      name: device.name,
      priority: device.priority,
      targets: [],
      available: true,
    })) as unknown as typeof state.latestDevices;
    state.devicesLoaded = true;
    const { renderPlan } = await import('../src/ui/plan.ts');
    renderPlan(normalized as Parameters<typeof renderPlan>[0]);
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
    (document.querySelector(`[data-device-id="${deviceId}"] .plan-card__state-power`) as HTMLElement | null)
      ?.textContent
      ?.trim()
  );
  
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (document as unknown as { hidden?: boolean }).hidden;
  });
  
  describe('Overview plan UI', () => {
    it('renders the hero bars and priority-sorted cards', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 5.2,
          softLimitKw: 11,
          headroomKw: 5.8,
          hardCapLimitKw: 14,
          controlledKw: 3.1,
          uncontrolledKw: 2.1,
          powerFreshnessState: 'fresh',
          usedKWh: 4.2,
          hourBudgetKWh: 11,
          softLimitSource: 'daily',
          minutesRemaining: 8}),
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
      // The subline names the binding ceiling: from 2026-08-02 the hero owns
      // that fact and the device cards stopped repeating it once per card, so
      // this is where the owner reads it (a hover tooltip is unreachable in the
      // touch WebView).
      expect((document.querySelector('.plan-hero .plan-hero__subline:not(.plan-hero__subline--muted)') as HTMLElement | null)
        ?.textContent?.trim()).toBe("Safe pace now 11.0 kW · set by today's budget");
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

    it('keeps the managed/background legend visible when managed draw is a known zero', async () => {
      // All managed devices idle (thermostats at setpoint report 0 W) is a
      // known split, not a missing one. Hiding the legend here reads as "the
      // split is broken" (owner feedback 2026-08-02) — a known 0 renders.
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 5.2,
          softLimitKw: 11,
          headroomKw: 5.8,
          controlledKw: 0,
          uncontrolledKw: 5.2,
          powerFreshnessState: 'fresh',
          usedKWh: 4.2,
          hourBudgetKWh: 11,
          minutesRemaining: 8}),
        devices: [
          { id: 'dev-1', name: 'First', priority: 1, currentState: 'off', plannedState: 'keep' },
        ],
      });

      const supportLines = Array.from(document.querySelectorAll('.plan-hero .plan-hero__energy-support'))
        .map((el) => el.textContent?.trim());
      expect(supportLines[0]).toContain('Managed 0.0 kW');
      expect(supportLines[0]).toContain('Background 5.2 kW');
    });

    it('omits the managed/background legend for a background-only household', async () => {
      // No controllable device exists, so `sumControlledUsageKw` answers a
      // known 0 forever — a permanent "Managed 0.0 kW" line is noise for a
      // household PELS only observes (spec: notes/overview-hero-spec.md).
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 5.2,
          softLimitKw: 11,
          headroomKw: 5.8,
          controlledKw: 0,
          uncontrolledKw: 5.2,
          powerFreshnessState: 'fresh',
          usedKWh: 4.2,
          hourBudgetKWh: 11,
          minutesRemaining: 8}),
        devices: [
          { id: 'dev-1', name: 'Battery', priority: 1, controllable: false, currentState: 'on', plannedState: 'keep' },
        ],
      });

      const supportLines = Array.from(document.querySelectorAll('.plan-hero .plan-hero__energy-support'))
        .map((el) => el.textContent?.trim());
      expect(supportLines.some((line) => line?.includes('Managed'))).toBe(false);
    });

    it('floors the projected-energy subline at zero during a net-export hour', async () => {
      // Net export: totalKw < 0 drives `used + totalKw*minutesRemaining/60`
      // negative (0.3 + (-2.0 * 46/60) ≈ -1.23). It must render as
      // "projected 0.00 kWh", never "projected -1.23 kWh".
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: -2.0,
          softLimitKw: 11,
          headroomKw: 13,
          hardCapLimitKw: 14,
          controlledKw: 0.2,
          uncontrolledKw: 0.1,
          powerFreshnessState: 'fresh',
          usedKWh: 0.3,
          hourBudgetKWh: 4.5,
          softLimitSource: 'daily',
          minutesRemaining: 46}),
        devices: [
          { id: 'dev-1', name: 'First', priority: 1, currentState: 'on', plannedState: 'keep' },
        ],
      });

      const sublines = Array.from(document.querySelectorAll('.plan-hero .plan-hero__subline'))
        .map((el) => el.textContent?.trim() ?? '');
      const projectedSubline = sublines.find((text) => text.startsWith('projected'));
      expect(projectedSubline).toBe('projected 0.00 kWh');
      // No projected surface may ever print a negative kWh — guard the subline AND
      // the energy-bar projection marker's tooltip/aria ("Projected this hour …"),
      // which read the same clamped value, so the test protects both paths.
      const heroHtml = document.querySelector('.plan-hero')?.outerHTML ?? '';
      expect(heroHtml).not.toContain('projected -');
      expect(heroHtml).not.toContain('Projected this hour -');
    });

    it('renders the "Budget exempt" chip on device cards', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({ totalKw: 0, softLimitKw: 5, headroomKw: 5}),
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
      ).toBe('Budget exempt');
    });

    it('renders the hero info button with the kW-vs-kWh tooltip', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 1.2,
          softLimitKw: 6,
          headroomKw: 4.8,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 30}),
        devices: [],
      });
      const infoButton = document.querySelector('.plan-hero__info-button') as HTMLElement | null;
      expect(infoButton).not.toBeNull();
      expect(infoButton?.getAttribute('aria-label')).toBe('About this card');
      expect(infoButton?.getAttribute('data-tooltip')).toMatch(/kW is speed\. kWh is distance\./);
    });

    it('renders segmented power-bar fills for managed and background draw', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 5.0,
          softLimitKw: 8,
          headroomKw: 3.0,
          hardCapLimitKw: 10,
          controlledKw: 3.0,
          uncontrolledKw: 2.0,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 30}),
        devices: [],
      });
      const segments = Array.from(document.querySelectorAll('.pels-meter-segments__seg'));
      expect(segments).toHaveLength(2);
      expect(segments[0]?.className).toContain('pels-meter-segments__seg--managed');
      expect(segments[1]?.className).toContain('pels-meter-segments__seg--background');
    });

    it('writes the spec decision sentence when nothing is being limited', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 1.2,
          softLimitKw: 6,
          headroomKw: 4.8,
          hardCapLimitKw: 8,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 38}),
        devices: [],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('Quiet hour. Nothing to do.');
    });

    it('writes the hard-cap decision sentence when the hour is on pace past the cap', async () => {
      // projected = 0.8 + 12 × 38/60 = 8.4 kWh > 8 kWh cap → trajectory alarm.
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 12,
          softLimitKw: 6,
          headroomKw: -6,
          hardCapLimitKw: 8,
          controlledKw: 3.0,
          uncontrolledKw: 9.0,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 38}),
        devices: [
          // Mid-shed and still drawing — PELS genuinely has load left to ease
          // off, so the action clause is honest.
          {
            id: 'dev-shed',
            name: 'Heater',
            currentState: 'on',
            plannedState: 'shed',
            stateKind: 'held',
            currentDrawKw: 1.2,
          },
        ],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('On pace to exceed the hard cap this hour. Easing devices off.');
      // The alert chip keys off the same trajectory judgement.
      expect((document.querySelector('.plan-hero .plan-chip--alert') as HTMLElement | null)?.textContent?.trim())
        .toBe('Above hard cap');
      // The energy bar renders the cap's kWh tick — the threshold that turned
      // the projection red, printed where the judgement lives (the projection
      // overshoot stretches the scale past the cap, so it fits).
      const energySection = document.querySelectorAll('.plan-hero .plan-hero__section')[1]!;
      const energyMarkerLabels = Array.from(energySection.querySelectorAll('.pels-meter-track__marker'))
        .map((m) => m.getAttribute('aria-label'));
      expect(energyMarkerLabels).toContain('Hard cap this hour 8.0 kWh');
      // Breathing motion must run in the over-hard-cap case too — it's the
      // most-active limiting state and the gate should not freeze it.
      expect(document.querySelector('.pels-meter-segments__seg--managed[data-limiting]')).not.toBeNull();
    });

    it('drops the action clause under simulation while the trajectory chip stays factual', async () => {
      // Same on-pace-past-the-cap hour, but capacity_dry_run is on: the banner
      // says devices stay as-is, so the sentence must not claim PELS is easing
      // anything off. The chip stays "Above hard cap" — the trajectory is a
      // fact regardless of whether PELS acts on it.
      vi.resetModules();
      setupPlanDom();
      // The hero reads simulation mode from the shared UI state (set by the
      // capacity settings loader in production), not from the plan snapshot.
      const { state } = await import('../src/ui/state.ts');
      state.dryRun = true;
      const { renderPlan } = await import('../src/ui/plan.ts');
      renderPlan(normalizePlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 12,
          softLimitKw: 6,
          headroomKw: -6,
          hardCapLimitKw: 8,
          controlledKw: 3.0,
          uncontrolledKw: 9.0,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 38}),
        devices: [
          { id: 'dev-shed', name: 'Heater', currentState: 'on', plannedState: 'shed', reason: 'shed due to capacity' },
        ],
      }) as Parameters<typeof renderPlan>[0]);
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('On pace to exceed the hard cap this hour.');
      expect((document.querySelector('.plan-hero .plan-chip--alert') as HTMLElement | null)?.textContent?.trim())
        .toBe('Above hard cap');
    });

    it('keeps the over-cap alarm when a zero-allocation budget hour hides the energy section', async () => {
      // Codex post-merge review: the projection tone is gated on the energy
      // bar existing (`hourBudgetKWh > 0`), but a zero-weighted daily-budget
      // hour can still be on pace past the cap — the chip must key off the
      // standalone trajectory verdict (same four meta fields as the
      // `pels_status` producer), or the hero goes silent while the headroom
      // widget shows red.
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          // projected = 4.9 + 2 × 10/60 ≈ 5.23 kWh > 5 kWh cap.
          totalKw: 2,
          softLimitKw: 0.5,
          headroomKw: -1.5,
          hardCapLimitKw: 5,
          controlledKw: 1.5,
          uncontrolledKw: 0.5,
          powerFreshnessState: 'fresh',
          usedKWh: 4.9,
          hourBudgetKWh: 0,
          minutesRemaining: 10}),
        devices: [],
      });
      // The energy section is structurally absent (no budget to render)…
      expect(document.querySelectorAll('.plan-hero .plan-hero__section')).toHaveLength(1);
      // …but the trajectory alarm still fires, matching the widget's verdict.
      expect((document.querySelector('.plan-hero .plan-chip--alert') as HTMLElement | null)?.textContent?.trim())
        .toBe('Above hard cap');
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('On pace to exceed the hard cap this hour.');
    });

    it('tells the honest story over the cap when the managed cascade is exhausted and a control-off device breaches', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          // projected = 0.8 + 7 × 38/60 ≈ 5.23 kWh > 5 kWh cap → trajectory alarm.
          totalKw: 7,
          softLimitKw: 4.5,
          headroomKw: -2.5,
          hardCapLimitKw: 5,
          controlledKw: 2.4,
          uncontrolledKw: 4.6,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 38}),
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
            currentDrawKw: 2.9,
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

    it('drops the action clause when every managed device is settled and the control-off device is parked at 0 W', async () => {
      // A control-off device drawing nothing is not the source of the breach, so
      // the "remaining draw is from it" recourse must not fire on it — and with
      // every managed device already settled off there is nothing left to ease
      // off either, so the action clause drops (Codex review, PR #1844).
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          // projected = 0.8 + 7 × 38/60 ≈ 5.23 kWh > 5 kWh cap → trajectory alarm.
          totalKw: 7,
          softLimitKw: 4.5,
          headroomKw: -2.5,
          hardCapLimitKw: 5,
          controlledKw: 2.4,
          uncontrolledKw: 4.6,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 38}),
        devices: [
          { id: 'dev-held', name: 'Heater', currentState: 'off', plannedState: 'shed', stateKind: 'held' },
          {
            id: 'dev-uncontrolled-off',
            name: 'Sauna',
            currentState: 'off',
            controllable: false,
            currentDrawKw: 0,
            reason: 'capacity control off',
          },
        ],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('On pace to exceed the hard cap this hour.');
    });

    it('keeps the default over-cap copy while a managed device is mid-shed but still drawing', async () => {
      // A controllable device selected for shedding (plannedState 'shed' → marked
      // 'held') that is still physically drawing means the cascade is NOT done —
      // PELS is mid-shed. The honest "already eased off" copy must not fire yet.
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          // projected = 0.8 + 7 × 38/60 ≈ 5.23 kWh > 5 kWh cap → trajectory alarm.
          totalKw: 7,
          softLimitKw: 4.5,
          headroomKw: -2.5,
          hardCapLimitKw: 5,
          controlledKw: 2.4,
          uncontrolledKw: 4.6,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 38}),
        devices: [
          // Selected for shedding but the element hasn't settled — still drawing.
          {
            id: 'dev-shedding',
            name: 'Heater',
            currentState: 'on',
            plannedState: 'shed',
            stateKind: 'held',
            currentDrawKw: 1.2,
          },
          {
            id: 'dev-uncontrolled',
            name: 'Sauna',
            currentState: 'on',
            controllable: false,
            currentDrawKw: 2.9,
            reason: 'capacity control off',
          },
        ],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('On pace to exceed the hard cap this hour. Easing devices off.');
    });

    it('keeps the default over-cap copy for a pending shed on an unmetered device', async () => {
      // A controllable device selected for shedding that is still drawing must
      // count as not-yet-settled, so the honest "already eased off" copy must not
      // fire while the shed is in flight.
      //
      // This used to be expressed as "no per-device power, fall back to on-like
      // state". There is no such state any more: the plan read model always
      // carries a resolved draw. This device reports 1.2 kW, and it is still
      // drawing, which is the thing the copy actually turns on.
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          // projected = 0.8 + 7 × 38/60 ≈ 5.23 kWh > 5 kWh cap → trajectory alarm.
          totalKw: 7,
          softLimitKw: 4.5,
          headroomKw: -2.5,
          hardCapLimitKw: 5,
          controlledKw: 2.4,
          uncontrolledKw: 4.6,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 38}),
        devices: [
          {
            id: 'dev-shedding',
            name: 'Heater',
            currentState: 'on',
            plannedState: 'shed',
            stateKind: 'held',
            currentDrawKw: 1.2,
          },
          {
            id: 'dev-uncontrolled',
            name: 'Sauna',
            currentState: 'on',
            controllable: false,
            currentDrawKw: 2.9,
            reason: 'capacity control off',
          },
        ],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('On pace to exceed the hard cap this hour. Easing devices off.');
    });

    it('writes the actively-limiting decision sentence when one device is held below safe pace', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 4.0,
          softLimitKw: 5,
          headroomKw: 1.0,
          hardCapLimitKw: 7,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 30}),
        devices: [
          { id: 'dev-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', stateKind: 'held' },
        ],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('Holding back 1 device so the house stays under 5.0 kW.');
    });

    it('uses the same declarative voice when limiting above safe pace', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 7.0,
          softLimitKw: 5,
          headroomKw: -2.0,
          hardCapLimitKw: 10,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 30}),
        devices: [
          { id: 'dev-shed', name: 'Heater', currentState: 'off', plannedState: 'shed', stateKind: 'held' },
        ],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('Holding back 1 device so the house stays under 5.0 kW.');
    });

    it('reflects projected-over-budget in the decision sentence so it does not contradict the Above budget chip', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          // currentKw 4.5 × 30/60 = 2.25 → projected 5.05 kWh, above 4.5 budget
          totalKw: 4.5,
          softLimitKw: 6,
          headroomKw: 1.5,
          hardCapLimitKw: 8,
          powerFreshnessState: 'fresh',
          usedKWh: 2.8,
          hourBudgetKWh: 4.5,
          minutesRemaining: 30}),
        devices: [],
      });
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('On pace to overshoot this hour’s energy budget.');
    });

    it('surfaces the "X kW above safe pace" subline when current power is above safe pace', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 6.5,
          softLimitKw: 5,
          headroomKw: -1.5,
          hardCapLimitKw: 8,
          powerFreshnessState: 'fresh',
          usedKWh: 0.8,
          hourBudgetKWh: 5,
          minutesRemaining: 30}),
        devices: [],
      });
      const subline = document.querySelector('.plan-hero .plan-hero__subline') as HTMLElement | null;
      expect(subline?.textContent?.trim())
        .toBe('1.5 kW above safe pace (5.0 kW \u00b7 set by this hour\'s pace)');
    });

    it('stays calm when instantaneous power is above the cap but the hour is on track', async () => {
      // Regression (owner report 2026-07-05): the hard cap is an hourly-average
      // tariff-step ceiling, so instantaneous kW above it is NOT a breach. Late
      // in an under-used hour the safe pace legitimately sits ABOVE the cap and
      // the planner deliberately tolerates this state — the hero must not show
      // an error chip, an over-cap subline, or an "easing off" claim.
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          // Draw 5.2 kW > cap 5.0 kW, but under safe pace 5.5 kW, and
          // projected = 1.9 + 5.2 × 28/60 ≈ 4.33 kWh < 4.5 kWh budget.
          totalKw: 5.2,
          softLimitKw: 5.5,
          headroomKw: 0.3,
          hardCapLimitKw: 5,
          controlledKw: 4.6,
          uncontrolledKw: 0.6,
          powerFreshnessState: 'fresh',
          usedKWh: 1.9,
          hourBudgetKWh: 4.5,
          minutesRemaining: 28}),
        devices: [
          { id: 'dev-held', name: 'Termostat', currentState: 'off', plannedState: 'shed', stateKind: 'held' },
        ],
      });
      // No alarm chip of any tone — this is normal operation.
      expect(document.querySelectorAll('.plan-hero .plan-chip')).toHaveLength(0);
      // The subline keeps the safe-pace value visible instead of an over-cap claim.
      const subline = document.querySelector('.plan-hero .plan-hero__subline') as HTMLElement | null;
      expect(subline?.textContent?.trim()).toBe('Safe pace now 5.5 kW \u00b7 set by this hour\'s pace');
      // The cap tick still renders even though safe pace sits above the cap —
      // previously it vanished in exactly this state.
      const powerMarkers = Array.from(document.querySelectorAll('.plan-hero .plan-hero__section')[0]!
        .querySelectorAll('.pels-meter-track__marker')) as HTMLElement[];
      expect(powerMarkers.map((m) => m.getAttribute('aria-label'))).toEqual([
        'Safe pace now 5.5 kW',
        'Hard cap 5.0 kW',
      ]);
      // The decision sentence describes what PELS is actually doing.
      expect((document.querySelector('.plan-hero__decision') as HTMLElement | null)?.textContent?.trim())
        .toBe('Holding back 1 device so the house stays under 5.5 kW.');
    });

    it('labels every hero meter marker with aria-label and a legend when more than one marker is present', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 5.2,
          softLimitKw: 11,
          headroomKw: 5.8,
          hardCapLimitKw: 14,
          controlledKw: 3.1,
          uncontrolledKw: 2.1,
          powerFreshnessState: 'fresh',
          usedKWh: 4.2,
          hourBudgetKWh: 11,
          minutesRemaining: 30}),
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

      // Energy bar has three markers: budget + projected end + the hard cap in
      // kWh. The cap sits ABOVE the budget (budget = cap − safety margin), so it
      // only stays on-scale because `computeEnergyBarScaleKWh` includes it —
      // without that it was dropped in exactly this healthy case and the cap was
      // never shown in the unit it governs (prod 2026-07-25).
      const energyMarkers = Array.from(sections[1]!.querySelectorAll('.pels-meter-track__marker')) as HTMLElement[];
      expect(energyMarkers).toHaveLength(3);
      expect(energyMarkers.map((m) => m.getAttribute('aria-label'))).toEqual([
        'Budget this hour 11.0 kWh',
        expect.stringMatching(/^Projected this hour [\d.]+ kWh$/),
        'Hard cap this hour 14.0 kWh',
      ]);

      // Each bar with more than one marker renders a sublegend row.
      const legends = Array.from(document.querySelectorAll('.plan-hero__legend')) as HTMLElement[];
      expect(legends).toHaveLength(2);
      const legendLabels = legends.map((l) => Array.from(l.querySelectorAll('.plan-hero__legend-label'))
        .map((el) => el.textContent?.trim()));
      expect(legendLabels[0]).toEqual(['Safe pace now 11.0 kW', 'Hard cap 14.0 kW']);
      // The kWh cap legend carries its value (the kW legend's number is a
      // different quantity — an instantaneous tick, not this hour's ceiling).
      expect(legendLabels[1]).toEqual(['Budget this hour', 'Projected this hour', 'Hard cap this hour 14.0 kWh']);
    });

    it('renders a visible legend naming every power-bar marker', async () => {
      // A marker's meaning otherwise lives only in a hover tooltip
      // (non-discoverable on touch) + aria-label, so the bar must render a
      // visible legend (progress-markers follow-up).
      //
      // This was "single-marker meter", premised on no hard cap being
      // configured. There is no such state: the cap is `capacitySettings.limitKw`,
      // always a number, and `notes/ui-terminology.md` says its tick always
      // renders. So the bar always carries both markers and the legend names both.
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 1.5,
          softLimitKw: 2.3,
          headroomKw: 0.8,
          controlledKw: 1.0,
          uncontrolledKw: 0.5,
          powerFreshnessState: 'fresh',
          usedKWh: 0.3,
          hourBudgetKWh: 4.5,
          minutesRemaining: 40}),
        devices: [],
      });

      const sections = Array.from(document.querySelectorAll('.plan-hero .plan-hero__section')) as HTMLElement[];
      const powerMarkers = Array.from(sections[0]!.querySelectorAll('.pels-meter-track__marker')) as HTMLElement[];
      expect(powerMarkers, 'power bar carries the safe-pace and hard-cap markers').toHaveLength(2);
      const powerLegend = sections[0]!.querySelector('.plan-hero__legend');
      expect(powerLegend, 'the power bar renders a legend').not.toBeNull();
      const labels = Array.from(powerLegend!.querySelectorAll('.plan-hero__legend-label')).map((el) => el.textContent?.trim());
      expect(labels).toEqual(['Safe pace now 2.3 kW', 'Hard cap 12.0 kW']);
    });

    it('explains a daily safe pace that includes power allowed beyond the daily budget', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 12.5,
          softLimitKw: 12,
          headroomKw: -0.5,
          softLimitSource: 'daily',
          budgetPaceKw: 5,
          projectedExemptKw: 7,
          controlledKw: 7,
          uncontrolledKw: 5.5,
          powerFreshnessState: 'fresh'}),
        devices: [],
      });

      const line = document.querySelector('.plan-hero__safe-pace-composition') as HTMLElement | null;
      expect(line?.textContent?.trim()).toBe(
        'Safe pace reserves 7.0 kW for devices allowed beyond today\'s budget; '
        + 'usage counted toward today\'s budget is paced at 5.0 kW.',
      );
      const marker = document.querySelector(
        '.plan-hero .pels-meter-track__marker--target',
      ) as HTMLElement | null;
      expect(marker?.dataset.tooltip).toContain(
        'today\'s budget paces counted usage at 5.0 kW, plus 7.0 kW reserved for devices allowed beyond it',
      );
      expect(document.querySelector('.plan-chip--warn')?.textContent).toBe('Above safe pace');
    });

    it.each([
      ['capacity source', { softLimitSource: 'capacity', budgetPaceKw: 5, projectedExemptKw: 7 }],
      ['zero allowance', { softLimitSource: 'daily', budgetPaceKw: 5, projectedExemptKw: 0 }],
      // Was "legacy payload", meaning a build that predated the composition
      // fields. There is no such payload — the settings UI ships inside the app
      // package with the runtime that feeds it. What it actually covers is the
      // real state underneath: a daily-bound hour with no allowance resolved.
      ['no allowance resolved', { softLimitSource: 'daily', budgetPaceKw: null, projectedExemptKw: null }],
    ] as const)('hides the daily safe-pace composition for %s', async (_case, fields) => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 4,
          softLimitKw: 5,
          headroomKw: 1,
          powerFreshnessState: 'fresh',
          ...fields}),
        devices: [],
      });

      expect(document.querySelector('.plan-hero__safe-pace-composition')).toBeNull();
    });

    it('uses only the explicit backend hour budget for the energy hero', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({
          totalKw: 0.6,
          softLimitKw: 4.5,
          headroomKw: 3.9,
          usedKWh: 0.02,
          hourBudgetKWh: 4.5,
          minutesRemaining: 58}),
        devices: [],
      });

      const headlines = Array.from(document.querySelectorAll('.plan-hero .plan-hero__headline'))
        .map((el) => el.textContent?.trim());
      expect(headlines.some((h) => h?.includes('0.0 of 4.5 kWh used'))).toBe(true);
      expect(headlines.some((h) => h?.includes('0.0 of 5.0 kWh used'))).toBe(false);
      expect(headlines.some((h) => h?.includes('0.0 of 9.5 kWh used'))).toBe(false);
      expect(headlines.some((h) => h?.includes('0.0 of 12.0 kWh used'))).toBe(false);
    });

  
    it('renders three-row cards with the state word below the title, load, and real reason text', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({ totalKw: 2.2, softLimitKw: 6, headroomKw: 3.8}),
        devices: [
          {
            id: 'dev-heat',
            name: 'Living Room Heat Pump',
            currentState: 'on',
            plannedState: 'keep',
            expectedPowerKw: 1.6,
            currentDrawKw: 1.2,
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
      // With no cooldown running, the header no longer repeats the state word
      // as a chip — the state word lives in the below-title state row only.
      expect(card?.querySelector('.plan-state-chip-wrap')).toBeNull();
      expect(getMetricText('dev-heat')).toBe('1.2 kW');
      expect(getReasonText('dev-heat')).toBe('Raising target 21° to 22°');
      // One anatomy: the status word + kW share a single below-title row.
      expect(card?.querySelector('.plan-card__state-row')).toBeTruthy();
      expect((card?.querySelector('.plan-card__state-label') as HTMLElement | null)?.textContent?.trim()).toBe('Running');
    });
  
    it('prefers structured state presentation from the snapshot payload', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({ totalKw: 0, softLimitKw: 5, headroomKw: 5}),
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
      expect(subline?.textContent?.trim()).toBe('Safe pace now 5.0 kW \u00b7 set by this hour\'s pace');
    });
  
    it('surfaces starvation badges and the held-back reason line', async () => {
      await renderPlanSnapshot({
        meta: buildPlanMeta({ totalKw: 4.2, softLimitKw: 5, headroomKw: 0.8}),
        devices: [
          {
            id: 'dev-starved',
            name: 'Bathroom Floor',
            currentState: 'off',
            plannedState: 'shed',
            starvation: {
              isStarved: true,
              accumulatedMs: 23 * 60 * 1000,
            },
          },
        ],
      });
  
      const badgeTexts = Array.from(document.querySelectorAll('[data-device-id="dev-starved"] .plan-chip'))
        .map((el) => el.textContent?.trim());
      expect(badgeTexts).toContain('Held back');
      expect(getReasonText('dev-starved')).toBe('Waiting for available power');
      // Starvation summary is shown on device card, not in hero
    });
  
    it('updates countdown-based reasons during live ticks', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));
      await renderPlanSnapshot({
        generatedAtMs: Date.now(),
        meta: buildPlanMeta({
          totalKw: 2.2,
          softLimitKw: 6,
          headroomKw: 3.8,
          lastPowerUpdateMs: Date.now()}),
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
        meta: buildPlanMeta({
          totalKw: 2.2,
          softLimitKw: 6,
          headroomKw: 3.8}),
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
      expect(getReasonText('dev-restore-cooldown')).toBe('Waiting to resume — 1s');
      // The restore countdown reads as `Resuming` (card grammar) — an
      // off+keep cooldown card must never regress to "Idle" beside a
      // waiting-to-resume reason.
      const cooldownCard = document.querySelector(
        '[data-device-id="dev-restore-cooldown"]',
      ) as HTMLElement | null;
      expect(cooldownCard?.dataset.stateKind).toBe('resuming');
      expect(cooldownCard?.querySelector('.plan-card__state-label')?.textContent).toBe('Resuming');
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
        meta: buildPlanMeta({
          totalKw: 2.2,
          softLimitKw: 6,
          headroomKw: 3.8}),
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
        meta: buildPlanMeta({ totalKw: 0, softLimitKw: 5, headroomKw: 5}),
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
        meta: buildPlanMeta({ totalKw: 0, softLimitKw: 5, headroomKw: 5}),
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
  
    it('shows the empty state only when the home genuinely manages no devices', async () => {
      // There is ONE empty state now, and it is a device-list verdict. A
      // missing plan used to produce its own "No plan available yet" blank
      // page, which meant an owner with ten managed devices and no power
      // reading saw exactly what an owner with none saw. The cards come from
      // the device list, so a missing plan costs the DECISIONS, not the
      // devices — see the undecided-card test below.
      await renderPlanSnapshot({
        meta: buildPlanMeta({ totalKw: 0, softLimitKw: 5, headroomKw: 5}),
        devices: [],
      });
      expect((document.querySelector('#plan-empty') as HTMLElement | null)?.textContent)
        .toContain('No managed devices');
      // The empty state links straight to the Devices settings page; the
      // delegated [data-settings-target] click handler does the navigation.
      const manageLink = document.querySelector('#plan-empty-manage-devices') as HTMLElement | null;
      expect(manageLink?.getAttribute('data-settings-target')).toBe('devices');
    });

    it('renders a card per managed device when PELS has not decided yet', async () => {
      // The state before the first power reading. The device list is known and
      // the plan is not, so the owner sees their devices and what PELS is
      // waiting on — not a blank page.
      vi.resetModules();
      setupPlanDom();
      const { state } = await import('../src/ui/state.ts');
      state.latestDevices = [
        { id: 'dev-1', name: 'Heater', targets: [], available: true },
      ] as unknown as typeof state.latestDevices;
      state.devicesLoaded = true;
      const { renderPlan } = await import('../src/ui/plan.ts');

      renderPlan(null);

      expect(document.querySelector('#plan-empty')).toBeNull();
      expect(document.querySelector('#plan-cards')?.textContent).toContain('Heater');
      expect(document.querySelector('#plan-cards')?.textContent)
        .toContain('Waiting for the first power reading');
    });

    it('keeps the device but drops its decision when the plan later becomes unavailable', async () => {
      vi.resetModules();
      setupPlanDom();
      // The Overview's cards are device rows, so seed the device list this
      // fixture implies.
      const { state } = await import('../src/ui/state.ts');
      state.latestDevices = [{ id: 'dev-clear', name: 'Device to clear', targets: [], available: true }] as unknown as typeof state.latestDevices;
      state.devicesLoaded = true;
      const { renderPlan } = await import('../src/ui/plan.ts');

      renderPlan(normalizePlanSnapshot({
        meta: buildPlanMeta({ totalKw: 2.2, softLimitKw: 6, headroomKw: 3.8}),
        devices: [{ id: 'dev-clear', name: 'Device to clear', currentState: 'on', plannedState: 'keep' }],
      }) as Parameters<typeof renderPlan>[0]);

      expect(document.querySelector('[data-device-id="dev-clear"]')).not.toBeNull();

      renderPlan(null);

      // The DECISION is gone, so the decided card is: `data-device-id` is
      // stamped by the plan-backed cards only. The DEVICE is not gone — losing
      // the plan is losing PELS's answer about the device, not the device
      // itself, and the surface says which one it lost.
      expect(document.querySelector('[data-device-id="dev-clear"]')).toBeNull();
      expect(document.querySelector('#plan-empty')).toBeNull();
      expect(document.querySelector('#plan-cards')?.textContent).toContain('Device to clear');
      expect(document.querySelector('#plan-cards')?.textContent)
        .toContain('Waiting for the first power reading');
    });

    it('refreshes the plan when the power endpoint fails', async () => {
      vi.resetModules();
      setupPlanDom();
      // The Overview's cards are device rows, so seed the device list this
      // fixture implies.
      const { state } = await import('../src/ui/state.ts');
      state.latestDevices = [{ id: 'dev-refresh', name: 'Refreshed device', targets: [], available: true }] as unknown as typeof state.latestDevices;
      state.devicesLoaded = true;
      const homey = installHomeyMock({
        uiState: {
          plan: normalizePlanSnapshot({
            meta: buildPlanMeta({ totalKw: 2.2, softLimitKw: 6, headroomKw: 3.8}),
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
            meta: buildPlanMeta({
              totalKw: 2.2,
              softLimitKw: 6,
              headroomKw: 3.8,
              powerFreshnessState: 'stale_fail_closed'}),
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
