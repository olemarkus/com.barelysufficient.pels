import { formatCheapestUpcomingHour } from '../../packages/shared-domain/src/planHeroSummary';

// End-to-end timezone regression suite for `formatCheapestUpcomingHour`. The
// production caller (`PlanHero.tsx`) renders the cheapest-upcoming-hour
// timestamp via `Date#getHours()`, which collapses to the host timezone. On a
// DST transition day the wall-clock hour the user sees must match the local
// hour that actually exists — never a skipped local hour on spring-forward, and
// the correct repeat on fall-back. Both Europe/Oslo DST boundaries in 2026 are
// exercised:
//   - Spring-forward: 2026-03-29 — local clock jumps 02:00 → 03:00 (23h day).
//     The local 02:xx hour does not exist; any cheap UTC slot landing in that
//     gap must render as 03:00.
//   - Fall-back:      2026-10-25 — local clock repeats 02:00 → 02:00 (25h day).
//     Both the first and second 02:00 local hours must render as 02:00.
//
// Suite is gated on `Europe/Oslo` (set by the timezone runner —
// `scripts/run-timezone-tests.mjs` — when invoked through `test:unit:tz`).
// When the host timezone is anything else, the assertions about local-hour
// formatting are meaningless, so we skip with a clear message rather than fail
// silently.

const OSLO = 'Europe/Oslo';
const HOUR_MS = 60 * 60 * 1000;

// Format an upcoming-hour timestamp in the host locale, 24h clock — mirrors
// `formatClockTimeShort` in `packages/settings-ui/src/ui/views/PlanHero.tsx` so
// this end-to-end test exercises the same formatter the production caller uses.
const formatClockTimeShort = (timestampMs: number): string => {
  const date = new Date(timestampMs);
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
};

const localOffsetMinutesAt = (utcMs: number): number => -new Date(utcMs).getTimezoneOffset();

const describeIfOslo = process.env.TZ === OSLO ? describe : describe.skip;

describeIfOslo(`formatCheapestUpcomingHour — DST end-to-end (${OSLO})`, () => {
  // Pre-flight: confirm the runner is actually applying TZ=Europe/Oslo so the
  // wall-clock formatting under test reflects local time, not UTC.
  it('host timezone is Europe/Oslo so wall-clock formatting matches the user', () => {
    // 2026-01-15 12:00 UTC → Oslo winter is UTC+1 (offset +60 minutes).
    expect(localOffsetMinutesAt(Date.UTC(2026, 0, 15, 12, 0, 0))).toBe(60);
    // 2026-07-15 12:00 UTC → Oslo summer is UTC+2 (offset +120 minutes).
    expect(localOffsetMinutesAt(Date.UTC(2026, 6, 15, 12, 0, 0))).toBe(120);
  });

  it('spring-forward day: a cheap slot landing in the skipped local hour renders as 03:00', () => {
    // 2026-03-29 — Europe/Oslo DST spring-forward.
    // Before 01:00 UTC the local offset is +1 (so 00:00 UTC = 01:00 local).
    // From  01:00 UTC the local offset is +2 (so 01:00 UTC = 03:00 local).
    // The local 02:xx hour therefore does not exist. A UTC slot at 01:00 UTC
    // becomes 03:00 local — not 02:00 — and the rendered text must reflect
    // that. This is the boundary the original bug-prone code (mis-formatting
    // with UTC hours or a stale offset cache) would have rendered as 02:00.
    const dstSpringJump = Date.UTC(2026, 2, 29, 1, 0, 0); // 03:00 Oslo
    const nowMs = Date.UTC(2026, 2, 28, 23, 0, 0);        // 2026-03-29 00:00 Oslo

    expect(formatCheapestUpcomingHour({
      hours: [
        { startsAtMs: Date.UTC(2026, 2, 28, 23, 0, 0), price: 50 }, // 00:00 Oslo, before window
        { startsAtMs: dstSpringJump, price: 12 },                   // 03:00 Oslo, cheapest
        { startsAtMs: Date.UTC(2026, 2, 29, 5, 0, 0), price: 40 },  // 07:00 Oslo
      ],
      nowMs,
      unitLabel: 'øre/kWh',
      formatClockTime: formatClockTimeShort,
    })).toBe('Cheapest hour ahead: 03:00, 12 øre/kWh.');
  });

  it('spring-forward day: hour-by-hour formatting skips the non-existent local 02:00', () => {
    // Pin the broader formatting contract — across all 23 real local hours on
    // the spring-forward day, the rendered clock text must walk
    // 00, 01, 03, 04, ..., 23, with no 02 entry. Defends the formatter's
    // local-aware behaviour against a refactor that re-introduces a UTC
    // assumption.
    // UTC range covers exactly the 23 real local hours of 2026-03-29:
    //   00:00 local (= 2026-03-28 23:00 UTC, +1) through
    //   23:00 local (= 2026-03-29 21:00 UTC, +2 after the jump at 01:00 UTC).
    const sampleUtcStart = Date.UTC(2026, 2, 28, 23, 0, 0); // 2026-03-29 00:00 Oslo (UTC+1)
    const sampleUtcEnd = Date.UTC(2026, 2, 29, 21, 0, 0);   // 2026-03-29 23:00 Oslo (UTC+2)

    const localHours: string[] = [];
    for (let ts = sampleUtcStart; ts <= sampleUtcEnd; ts += HOUR_MS) {
      localHours.push(formatClockTimeShort(ts).slice(0, 2));
    }

    expect(localHours).toHaveLength(23);
    expect(localHours).not.toContain('02');
    expect(localHours[0]).toBe('00');
    expect(localHours[1]).toBe('01');
    expect(localHours[2]).toBe('03'); // the jump
    expect(localHours[localHours.length - 1]).toBe('23');
  });

  it('fall-back day: the cheapest slot in the repeated 02:00 local hour renders as 02:00', () => {
    // 2026-10-25 — Europe/Oslo DST fall-back.
    // Before 01:00 UTC the local offset is +2 (so 00:00 UTC = 02:00 local).
    // From  01:00 UTC the local offset is +1 (so 01:00 UTC = 02:00 local).
    // The 02:xx local hour therefore occurs twice. Both UTC slots in that
    // pair must render as 02:00. This is the symmetric boundary to
    // spring-forward — the formatter must not error or surface "01" / "03"
    // for either of them.
    const firstOslo0200 = Date.UTC(2026, 9, 25, 0, 0, 0);   // 02:00 Oslo (UTC+2), first
    const secondOslo0200 = Date.UTC(2026, 9, 25, 1, 0, 0);  // 02:00 Oslo (UTC+1), second
    const nowMs = Date.UTC(2026, 9, 24, 23, 0, 0);          // 2026-10-25 01:00 Oslo

    // First-pass cheap slot.
    expect(formatCheapestUpcomingHour({
      hours: [{ startsAtMs: firstOslo0200, price: 12 }],
      nowMs,
      unitLabel: 'øre/kWh',
      formatClockTime: formatClockTimeShort,
    })).toBe('Cheapest hour ahead: 02:00, 12 øre/kWh.');

    // Second-pass cheap slot (the repeated 02:00) — same rendering.
    expect(formatCheapestUpcomingHour({
      hours: [{ startsAtMs: secondOslo0200, price: 8 }],
      nowMs,
      unitLabel: 'øre/kWh',
      formatClockTime: formatClockTimeShort,
    })).toBe('Cheapest hour ahead: 02:00, 8 øre/kWh.');
  });

  it('fall-back day: hour-by-hour formatting walks 25 local hours and includes 02:00 twice', () => {
    // Symmetric pin to the spring-forward walk. Across the 25 real local
    // hours, the rendered clock text must walk 00, 01, 02, 02, 03, ..., 23
    // with the 02 entry appearing exactly twice.
    const sampleUtcStart = Date.UTC(2026, 9, 24, 22, 0, 0); // 2026-10-25 00:00 Oslo (UTC+2)
    const sampleUtcEnd = Date.UTC(2026, 9, 25, 22, 0, 0);   // 2026-10-25 23:00 Oslo (UTC+1)

    const localHours: string[] = [];
    for (let ts = sampleUtcStart; ts <= sampleUtcEnd; ts += HOUR_MS) {
      localHours.push(formatClockTimeShort(ts).slice(0, 2));
    }

    expect(localHours).toHaveLength(25);
    const twoCount = localHours.filter((h) => h === '02').length;
    expect(twoCount).toBe(2);
    expect(localHours[0]).toBe('00');
    expect(localHours[1]).toBe('01');
    expect(localHours[2]).toBe('02'); // first 02
    expect(localHours[3]).toBe('02'); // repeated 02
    expect(localHours[4]).toBe('03');
    expect(localHours[localHours.length - 1]).toBe('23');
  });

  it('horizon window respects local DST: 18h ahead crosses spring-forward without dropping the cheap slot', () => {
    // Default horizon is 18 *wall* hours (input.horizonMs is ms). On the
    // spring-forward day the wall-clock advances 23 hours per civil day, so a
    // user looking at "tonight + tomorrow morning" still wants to see slots
    // through 18h of *elapsed real time*. The helper uses ms math, so the
    // window naturally tracks elapsed UTC time — but pin the behaviour so a
    // future refactor that introduced a wall-clock horizon doesn't silently
    // truncate cheap slots across the DST jump.
    const nowMs = Date.UTC(2026, 2, 28, 22, 0, 0);          // 2026-03-28 23:00 Oslo (winter, UTC+1)
    const sixteenHoursLaterUtcMs = nowMs + 16 * HOUR_MS;    // crosses the DST jump
    expect(formatCheapestUpcomingHour({
      hours: [
        { startsAtMs: nowMs + 2 * HOUR_MS, price: 90 },     // 01:00 Oslo
        { startsAtMs: sixteenHoursLaterUtcMs, price: 7 },   // 16h ahead, after DST jump
      ],
      nowMs,
      unitLabel: 'øre/kWh',
      formatClockTime: formatClockTimeShort,
    })).toBe(`Cheapest hour ahead: ${formatClockTimeShort(sixteenHoursLaterUtcMs)}, 7 øre/kWh.`);
  });
});
