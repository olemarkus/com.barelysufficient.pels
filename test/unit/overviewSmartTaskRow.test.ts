import {
  formatOverviewSmartTaskRowLine,
  resolveOverviewSmartTaskRow,
  type OverviewSmartTaskStatusInput,
} from '../../packages/shared-domain/src/overviewSmartTaskRow';

const formatTime = (ms: number): string => `T${ms}`;

const status = (
  overrides: Partial<OverviewSmartTaskStatusInput> = {},
): OverviewSmartTaskStatusInput => ({
  deviceName: 'Water Heater',
  statusId: 'on_track',
  deadlineAtMs: 1_000,
  ...overrides,
});

describe('resolveOverviewSmartTaskRow — priority ladder', () => {
  it('renders nothing with no active tasks and no recent misses', () => {
    expect(resolveOverviewSmartTaskRow({ statuses: [], missStreaks: [], formatTime })).toBeNull();
  });

  it('steady: aggregates healthy tasks with the lowercase mid-sentence status word', () => {
    expect(resolveOverviewSmartTaskRow({
      statuses: [status(), status({ deviceName: 'EV', statusId: 'queued' })],
      missStreaks: [],
      formatTime,
    })).toEqual({
      tone: 'muted', variant: 'steady', deviceName: null, statusText: '2 smart tasks · on track',
    });
    expect(resolveOverviewSmartTaskRow({
      statuses: [status()], missStreaks: [], formatTime,
    })?.statusText).toBe('1 smart task · on track');
  });

  it('never claims "on track" for building-plan or satisfied tasks', () => {
    // No allocation yet → claiming on-track would overclaim; already
    // satisfied → complete. Both render nothing rather than a wrong count.
    expect(resolveOverviewSmartTaskRow({
      statuses: [status({ statusId: 'building_plan' })], missStreaks: [], formatTime,
    })).toBeNull();
    expect(resolveOverviewSmartTaskRow({
      statuses: [status({ statusId: 'satisfied' })], missStreaks: [], formatTime,
    })).toBeNull();
    // A mixed set counts only the genuinely on-track tasks.
    expect(resolveOverviewSmartTaskRow({
      statuses: [status(), status({ statusId: 'building_plan', deviceName: 'EV' })],
      missStreaks: [],
      formatTime,
    })?.statusText).toBe('1 smart task · on track');
  });

  it('at risk outranks steady and uses the canonical Ready-by grammar', () => {
    const row = resolveOverviewSmartTaskRow({
      statuses: [status(), status({ deviceName: 'Connected 300', statusId: 'at_risk', deadlineAtMs: 500 })],
      missStreaks: [],
      formatTime,
    });
    expect(row).toEqual({
      tone: 'warn',
      variant: 'at_risk',
      deviceName: 'Connected 300',
      statusText: 'At risk · Ready by T500',
    });
    expect(formatOverviewSmartTaskRowLine(row!)).toBe('Connected 300 — At risk · Ready by T500');
  });

  it('paused uses the compressed widget word (no triple-dash chain) and ranks below at risk', () => {
    expect(resolveOverviewSmartTaskRow({
      statuses: [status({ statusId: 'paused_unplugged', deviceName: 'EV charger' })],
      missStreaks: [],
      formatTime,
    })).toMatchObject({ variant: 'paused', tone: 'warn', statusText: 'Unplugged' });
    expect(resolveOverviewSmartTaskRow({
      statuses: [
        status({ statusId: 'paused_unplugged', deviceName: 'EV charger' }),
        status({ statusId: 'at_risk', deviceName: 'Boiler' }),
      ],
      missStreaks: [],
      formatTime,
    })?.variant).toBe('at_risk');
  });

  it('the miss rollup outranks at risk but NOT a live cannot-finish (still preventable)', () => {
    const miss = { deviceName: 'Water Heater', line: '3 of last 4 runs missed' };
    expect(resolveOverviewSmartTaskRow({
      statuses: [status({ statusId: 'at_risk' })],
      missStreaks: [miss],
      formatTime,
    })).toMatchObject({ variant: 'miss_streak', tone: 'alert', statusText: '3 of last 4 runs missed' });
    expect(resolveOverviewSmartTaskRow({
      statuses: [status({ statusId: 'cannot_meet', deviceName: 'Boiler', deadlineAtMs: 700 })],
      missStreaks: [miss],
      formatTime,
    })).toMatchObject({
      variant: 'cannot_finish',
      tone: 'alert',
      deviceName: 'Boiler',
      // Failing states swap Ready by → Due (the registered ETA grammar).
      statusText: 'Cannot finish · Due T700',
    });
  });

  it('picks the soonest deadline when several tasks share the worst status', () => {
    expect(resolveOverviewSmartTaskRow({
      statuses: [
        status({ statusId: 'cannot_meet', deviceName: 'Later', deadlineAtMs: 900 }),
        status({ statusId: 'cannot_meet', deviceName: 'Sooner', deadlineAtMs: 100 }),
      ],
      missStreaks: [],
      formatTime,
    })?.deviceName).toBe('Sooner');
  });
});
