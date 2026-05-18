import {
  resolveDeadlinesListHero,
  type DeadlinesListHeroCard,
} from '../packages/shared-domain/src/deadlinesListHero';

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

  // `paused_unplugged` deserves its own hero-reason clause because the chip
  // label ("Paused — unplugged") contains an em-dash that would collide with
  // the subline's connecting em-dash when inlined verbatim. The hero map
  // renders the clause "car unplugged" so the line stays single-clause.
  it('renders "car unplugged" as the reason for paused_unplugged cards', () => {
    const hero = resolveDeadlinesListHero({
      cards: [buildCard({ deviceName: 'Tesla', statusId: 'paused_unplugged', deadlineAtMs: T0 })],
      formatTime,
    });
    expect(hero?.headline).toBe('1 deadline at risk.');
    expect(hero?.subline).toBe('Tesla due 06:30 — car unplugged.');
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
});
