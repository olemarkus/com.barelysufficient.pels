import {
  DEADLINES_LIST_BASELINE_HEADLINE_BY_STATE,
  DEADLINES_LIST_BETWEEN_RUNS_BODY,
  resolveDeadlinesListHero,
  type DeadlinesListHeroCard,
} from '../../packages/shared-domain/src/deadlinesListHero';

// Pre-resolved HH:MM formatter — shared-domain stays free of locale helpers,
// so the test supplies a deterministic UTC stub. Mirrors what the settings UI
// passes in (`formatTimeInTimeZone(..., browser zone)`); fixing it to UTC
// here keeps the assertions stable across CI / dev clocks.
const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 4, 18, 6, 30, 0); // 06:30 UTC

const formatTime = (ms: number): string => {
  const d = new Date(ms);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
};

const buildCard = (overrides: Partial<DeadlinesListHeroCard> = {}): DeadlinesListHeroCard => ({
  deviceId: 'dev_tesla',
  deviceName: 'Tesla',
  kind: 'ev_soc',
  deadlineAtMs: T0,
  firstActionAtMs: T0 - 4 * HOUR_MS, // 02:30
  statusId: 'on_track',
  ...overrides,
});

describe('resolveDeadlinesListHero', () => {
  it('returns null when no cards are present (empty-state owns its own copy)', () => {
    expect(resolveDeadlinesListHero({ cards: [], formatTime })).toBeNull();
  });

  it('renders "N deadlines on track." when nothing is at risk', () => {
    const hero = resolveDeadlinesListHero({
      cards: [buildCard(), buildCard({ deviceName: 'Boiler', kind: 'temperature' }), buildCard({ deviceName: 'Floor', kind: 'temperature' })],
      formatTime,
    });
    expect(hero).not.toBeNull();
    expect(hero?.headline).toBe('3 deadlines on track.');
    expect(hero?.tone).toBe('good');
  });

  it('uses the singular form when exactly one card is on track', () => {
    const hero = resolveDeadlinesListHero({ cards: [buildCard()], formatTime });
    expect(hero?.headline).toBe('1 deadline on track.');
  });

  it('names the soonest deadline with its kind verb and first-action time on the subline', () => {
    const hero = resolveDeadlinesListHero({
      cards: [buildCard({ deviceName: 'Tesla', kind: 'ev_soc', firstActionAtMs: T0 - 4 * HOUR_MS })],
      formatTime,
    });
    expect(hero?.subline).toBe('Tesla ready by 06:30, charging from 02:30.');
  });

  it('uses "heating" for thermal kinds', () => {
    const hero = resolveDeadlinesListHero({
      cards: [buildCard({ deviceName: 'Boiler', kind: 'temperature', firstActionAtMs: T0 - 2 * HOUR_MS })],
      formatTime,
    });
    expect(hero?.subline).toBe('Boiler ready by 06:30, heating from 04:30.');
  });

  it('drops the "from HH:MM" clause when the first action time is unknown', () => {
    const hero = resolveDeadlinesListHero({
      cards: [buildCard({ deviceName: 'Tesla', firstActionAtMs: null })],
      formatTime,
    });
    expect(hero?.subline).toBe('Tesla ready by 06:30.');
  });

  it('switches to "N of M deadlines at risk." headline when some cards are at risk', () => {
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({ statusId: 'on_track' }),
        buildCard({ deviceName: 'Boiler', kind: 'temperature', statusId: 'at_risk' }),
      ],
      formatTime,
    });
    expect(hero?.headline).toBe('1 of 2 deadlines at risk.');
    expect(hero?.tone).toBe('warn');
  });

  it('uses the bare "N deadlines at risk." form when only at-risk cards exist', () => {
    const hero = resolveDeadlinesListHero({
      cards: [buildCard({ deviceName: 'Boiler', kind: 'temperature', statusId: 'at_risk' })],
      formatTime,
    });
    expect(hero?.headline).toBe('1 deadline at risk.');
  });

  it('counts multiple at-risk cards (excluding healthy siblings) with mixed-cohort framing', () => {
    // 2 of 3 are at risk — the framing "N of M deadlines at risk." reads
    // truer than the bare "N deadlines at risk." when one sibling is healthy.
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({ statusId: 'on_track' }),
        buildCard({ deviceName: 'Boiler', kind: 'temperature', statusId: 'at_risk' }),
        buildCard({ deviceName: 'Floor', kind: 'temperature', statusId: 'cannot_meet' }),
      ],
      formatTime,
    });
    expect(hero?.headline).toBe('2 of 3 deadlines at risk.');
  });

  it('drops the mixed-cohort framing when every card is at risk', () => {
    // All cards at risk — "3 of 3 deadlines at risk." would read mechanical;
    // keep the bare "N deadlines at risk." form so the headline stays clean.
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({ deviceName: 'Tesla', statusId: 'at_risk' }),
        buildCard({ deviceName: 'Boiler', kind: 'temperature', statusId: 'at_risk' }),
        buildCard({ deviceName: 'Floor', kind: 'temperature', statusId: 'cannot_meet' }),
      ],
      formatTime,
    });
    expect(hero?.headline).toBe('3 deadlines at risk.');
  });

  it('escalates tone to alert when any at-risk card cannot finish', () => {
    const hero = resolveDeadlinesListHero({
      cards: [buildCard({ statusId: 'cannot_meet' })],
      formatTime,
    });
    expect(hero?.tone).toBe('alert');
  });

  it('names the soonest at-risk card with its status label as the reason', () => {
    const hero = resolveDeadlinesListHero({
      cards: [
        // Sorted by deadline ascending — the caller (DeadlinesList) already
        // sorts. The soonest at-risk card is the first one with a risky
        // status, not the absolute first card.
        buildCard({ deviceName: 'Tesla', statusId: 'on_track', deadlineAtMs: T0 }),
        buildCard({
          deviceName: 'Boiler',
          kind: 'temperature',
          statusId: 'at_risk',
          deadlineAtMs: T0 + HOUR_MS, // 07:30
        }),
      ],
      formatTime,
    });
    expect(hero?.subline).toBe('Boiler due 07:30 — at risk.');
  });

  // Tone / subline alignment: when at least one card escalates the tone to
  // `alert` (red) via `cannot_meet`, the subline must also name a
  // `cannot_meet` card. Naming a merely-`at_risk` card under a red banner
  // would read "Boiler due 07:30 — at risk." beneath a red hero — a tonal
  // contradiction. Verify the resolver promotes the soonest `cannot_meet`
  // for the subline even when an earlier-deadline `at_risk` card exists.
  it('names the soonest cannot_meet card on the subline when tone is alert', () => {
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({
          deviceId: 'dev_at_risk',
          deviceName: 'Boiler',
          kind: 'temperature',
          statusId: 'at_risk',
          deadlineAtMs: T0,
        }),
        buildCard({
          deviceId: 'dev_cannot_meet',
          deviceName: 'Floor',
          kind: 'temperature',
          statusId: 'cannot_meet',
          deadlineAtMs: T0 + HOUR_MS,
        }),
      ],
      formatTime,
    });
    expect(hero?.tone).toBe('alert');
    expect(hero?.subline).toBe('Floor due 07:30 — cannot finish in time.');
    expect(hero?.sublineTarget).toEqual({ deviceId: 'dev_cannot_meet' });
  });

  it('renders "cannot finish in time" as the reason for cannot-meet cards', () => {
    const hero = resolveDeadlinesListHero({
      cards: [buildCard({ deviceName: 'Boiler', kind: 'temperature', statusId: 'cannot_meet', deadlineAtMs: T0 })],
      formatTime,
    });
    expect(hero?.subline).toBe('Boiler due 06:30 — cannot finish in time.');
  });

  // `paused_unplugged` is its own warn-tone bucket: the user must act
  // (plug back in) before the plan can deliver, so the hero must not
  // collapse paused cards into the healthy-tone "Planning N deadlines."
  // branch. A lone paused card surfaces under the bare "N deadlines paused."
  // headline with `tone: 'warn'`, and the subline uses the at-risk-shaped
  // "due HH:MM — car unplugged." framing so the hero never claims a
  // delivery the device can't make.
  it('classifies a lone paused_unplugged card as paused (warn tone), not pending', () => {
    const hero = resolveDeadlinesListHero({
      cards: [buildCard({ deviceName: 'Tesla', statusId: 'paused_unplugged', deadlineAtMs: T0 })],
      formatTime,
    });
    expect(hero?.headline).toBe('1 deadline paused.');
    expect(hero?.tone).toBe('warn');
    expect(hero?.subline).toBe('Tesla due 06:30 — car unplugged.');
  });

  it('names "charging won’t resume" — not "car unplugged" — for a paused_not_resumable card', () => {
    // The connected-but-not-resumable card shares the `paused` bucket, but the
    // subline must name the real recovery (check the charger), never tell a
    // plugged-in owner to replug.
    const hero = resolveDeadlinesListHero({
      cards: [buildCard({ deviceName: 'Tesla', statusId: 'paused_not_resumable', deadlineAtMs: T0 })],
      formatTime,
    });
    expect(hero?.headline).toBe('1 deadline paused.');
    expect(hero?.tone).toBe('warn');
    expect(hero?.subline).toBe('Tesla due 06:30 — charging won’t resume.');
  });

  // Paused outranks pending / on-track / satisfied so a mixed list with one
  // paused card and healthy siblings reads "1 of N deadlines paused." under
  // a warn-tone hero — surfacing the user-actionable card instead of
  // claiming "Planning N deadlines." while the EV sits unplugged.
  it('uses the N-of-M paused framing when paused is mixed with pending / on-track', () => {
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({
          deviceId: 'dev_paused',
          deviceName: 'Tesla',
          statusId: 'paused_unplugged',
          deadlineAtMs: T0,
        }),
        buildCard({
          deviceId: 'dev_plan',
          deviceName: 'Boiler',
          kind: 'temperature',
          statusId: 'building_plan',
          deadlineAtMs: T0 + HOUR_MS,
        }),
      ],
      formatTime,
    });
    expect(hero?.headline).toBe('1 of 2 deadlines paused.');
    expect(hero?.tone).toBe('warn');
    expect(hero?.subline).toBe('Tesla due 06:30 — car unplugged.');
    expect(hero?.sublineTarget).toEqual({ deviceId: 'dev_paused' });
  });

  // At-risk still wins over paused (worst-wins). When both exist the hero
  // reports the at-risk count and tone, not the paused one — the failing
  // plan is the more urgent answer than the unplugged car.
  it('keeps at-risk precedence over paused (worst-wins)', () => {
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({
          deviceId: 'dev_paused',
          deviceName: 'Tesla',
          statusId: 'paused_unplugged',
          deadlineAtMs: T0,
        }),
        buildCard({
          deviceId: 'dev_risk',
          deviceName: 'Boiler',
          kind: 'temperature',
          statusId: 'at_risk',
          deadlineAtMs: T0 + HOUR_MS,
        }),
      ],
      formatTime,
    });
    expect(hero?.headline).toBe('1 of 2 deadlines at risk.');
    expect(hero?.tone).toBe('warn');
    expect(hero?.sublineTarget).toEqual({ deviceId: 'dev_risk' });
  });

  it('falls back to a kind-based label when the device name is empty', () => {
    const hero = resolveDeadlinesListHero({
      cards: [buildCard({ deviceName: '   ', kind: 'ev_soc' })],
      formatTime,
    });
    expect(hero?.subline.startsWith('EV ready by')).toBe(true);
  });

  it('emits the on-track sublineTarget pointing at the soonest deadline', () => {
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({ deviceId: 'dev_soonest', deadlineAtMs: T0 }),
        buildCard({ deviceId: 'dev_later', deadlineAtMs: T0 + HOUR_MS }),
      ],
      formatTime,
    });
    expect(hero?.sublineTarget).toEqual({ deviceId: 'dev_soonest' });
  });

  it('emits the at-risk sublineTarget pointing at the soonest at-risk card', () => {
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({ deviceId: 'dev_ok', statusId: 'on_track', deadlineAtMs: T0 }),
        buildCard({
          deviceId: 'dev_at_risk',
          deviceName: 'Boiler',
          kind: 'temperature',
          statusId: 'at_risk',
          deadlineAtMs: T0 + HOUR_MS,
        }),
      ],
      formatTime,
    });
    expect(hero?.sublineTarget).toEqual({ deviceId: 'dev_at_risk' });
  });

  // ── Mixed-state classification (PR-20) ──────────────────────────────────
  // Pre-PR-20, every non-at-risk card collapsed to "on track" — a
  // `building_plan` + `cannot_meet` pair claimed "2 deadlines on track"
  // under a red banner. These cases exercise the four-bucket split-clause
  // headlines so a future "everything not at-risk is on-track" lump can't
  // grow back unnoticed.

  it('renders the split-clause headline for mixed pending + on_track cards', () => {
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({ deviceId: 'dev_a', statusId: 'on_track', deadlineAtMs: T0 }),
        buildCard({
          deviceId: 'dev_b',
          deviceName: 'Boiler',
          kind: 'temperature',
          statusId: 'building_plan',
          deadlineAtMs: T0 + HOUR_MS,
        }),
      ],
      formatTime,
    });
    expect(hero?.headline).toBe('1 on track, 1 planning.');
    expect(hero?.tone).toBe('good');
    // Subline names the soonest deadline across the whole list (the on-track
    // Tesla here), not just the soonest of any one bucket — keeps one
    // subline shape across pure on-track / pure pending / pure satisfied /
    // mixed.
    expect(hero?.sublineTarget).toEqual({ deviceId: 'dev_a' });
  });

  it('escalates to the at-risk headline when at_risk is mixed with pending', () => {
    // Mixed pending + at_risk: the at-risk branch wins (worst-wins). The
    // `N of M` mixed-cohort framing fires because not every card is at-risk.
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({ deviceId: 'dev_pending', statusId: 'building_plan', deadlineAtMs: T0 }),
        buildCard({
          deviceId: 'dev_risk',
          deviceName: 'Boiler',
          kind: 'temperature',
          statusId: 'at_risk',
          deadlineAtMs: T0 + HOUR_MS,
        }),
      ],
      formatTime,
    });
    expect(hero?.headline).toBe('1 of 2 deadlines at risk.');
    expect(hero?.tone).toBe('warn');
    expect(hero?.sublineTarget).toEqual({ deviceId: 'dev_risk' });
  });

  it('escalates to alert when cannot_meet is mixed with pending', () => {
    // This is the worst-case PR-20 fixes: pre-fix, the hero said
    // "2 deadlines on track." while a cannot_meet card sat below in red.
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({ deviceId: 'dev_pending', statusId: 'building_plan', deadlineAtMs: T0 }),
        buildCard({
          deviceId: 'dev_cannot',
          deviceName: 'Boiler',
          kind: 'temperature',
          statusId: 'cannot_meet',
          deadlineAtMs: T0 + HOUR_MS,
        }),
      ],
      formatTime,
    });
    expect(hero?.headline).toBe('1 of 2 deadlines at risk.');
    expect(hero?.tone).toBe('alert');
    expect(hero?.subline).toBe('Boiler due 07:30 — cannot finish in time.');
    expect(hero?.sublineTarget).toEqual({ deviceId: 'dev_cannot' });
  });

  it('renders the split-clause headline for satisfied + on_track cards', () => {
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({ deviceId: 'dev_done', statusId: 'satisfied', deadlineAtMs: T0 }),
        buildCard({
          deviceId: 'dev_live',
          deviceName: 'Boiler',
          kind: 'temperature',
          statusId: 'on_track',
          deadlineAtMs: T0 + HOUR_MS,
        }),
      ],
      formatTime,
    });
    // Clause order is fixed: on-track → pending → satisfied, regardless of
    // input order.
    expect(hero?.headline).toBe('1 on track, 1 complete.');
    expect(hero?.tone).toBe('good');
  });

  it('renders "Planning N deadlines." when every card is pending', () => {
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({ deviceId: 'dev_a', statusId: 'building_plan', deadlineAtMs: T0 }),
        buildCard({
          deviceId: 'dev_b',
          deviceName: 'Boiler',
          kind: 'temperature',
          statusId: 'queued',
          deadlineAtMs: T0 + HOUR_MS,
        }),
      ],
      formatTime,
    });
    expect(hero?.headline).toBe('Planning 2 deadlines.');
    expect(hero?.tone).toBe('good');
  });

  it('renders "N deadlines complete." when every card is satisfied', () => {
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({ deviceId: 'dev_a', statusId: 'satisfied', deadlineAtMs: T0 }),
        buildCard({
          deviceId: 'dev_b',
          deviceName: 'Boiler',
          kind: 'temperature',
          statusId: 'satisfied',
          deadlineAtMs: T0 + HOUR_MS,
        }),
      ],
      formatTime,
    });
    expect(hero?.headline).toBe('2 deadlines complete.');
    expect(hero?.tone).toBe('good');
  });

  it('renders the split-clause headline for satisfied + pending cards', () => {
    // Mixed satisfied + pending — neither bucket has an on-track member, so
    // the clause set elides `X on track` cleanly and reads `Y planning,
    // Z complete.` in the fixed pending → satisfied order.
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({ deviceId: 'dev_done', statusId: 'satisfied', deadlineAtMs: T0 }),
        buildCard({
          deviceId: 'dev_plan',
          deviceName: 'Boiler',
          kind: 'temperature',
          statusId: 'building_plan',
          deadlineAtMs: T0 + HOUR_MS,
        }),
      ],
      formatTime,
    });
    expect(hero?.headline).toBe('1 planning, 1 complete.');
    expect(hero?.tone).toBe('good');
  });

  it('renders the three-clause headline for on_track + pending + satisfied', () => {
    const hero = resolveDeadlinesListHero({
      cards: [
        buildCard({ deviceId: 'dev_done', statusId: 'satisfied', deadlineAtMs: T0 }),
        buildCard({
          deviceId: 'dev_live',
          deviceName: 'Boiler',
          kind: 'temperature',
          statusId: 'on_track',
          deadlineAtMs: T0 + HOUR_MS,
        }),
        buildCard({
          deviceId: 'dev_plan',
          deviceName: 'Floor',
          kind: 'temperature',
          statusId: 'building_plan',
          deadlineAtMs: T0 + 2 * HOUR_MS,
        }),
      ],
      formatTime,
    });
    expect(hero?.headline).toBe('1 on track, 1 planning, 1 complete.');
    expect(hero?.tone).toBe('good');
  });
});

// Baseline-header copy for the two zero-active-card empty states (PR1 "Tell
// the truth"). The active list distinguishes a true first run from a
// between-runs lull; these constants are the shared source for both the
// header headline and the between-runs body so the view never inlines the
// strings (Rule 4 — UI text shared with logs).
describe('empty-state baseline copy', () => {
  it('keeps the first-run headline inviting the user to add their first task', () => {
    expect(DEADLINES_LIST_BASELINE_HEADLINE_BY_STATE.empty).toBe('Add your first smart task');
  });

  it('uses a between-runs headline that never says "first" or "yet"', () => {
    const headline = DEADLINES_LIST_BASELINE_HEADLINE_BY_STATE.empty_between_runs;
    expect(headline).toBe('No smart tasks scheduled');
    expect(headline.toLowerCase()).not.toContain('first');
    expect(headline.toLowerCase()).not.toContain('yet');
  });

  it('points the between-runs body at the Past tasks archive without first-run framing', () => {
    expect(DEADLINES_LIST_BETWEEN_RUNS_BODY).toContain('Past tasks');
    expect(DEADLINES_LIST_BETWEEN_RUNS_BODY.toLowerCase()).not.toContain('first');
    expect(DEADLINES_LIST_BETWEEN_RUNS_BODY.toLowerCase()).not.toContain('yet');
  });
});
