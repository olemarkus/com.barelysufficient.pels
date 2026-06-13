import { createWidgetErrorReporter, widgetErrorReporter } from '../../widgets/_shared/widgetClientLog';

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

// Mirrors `ReporterHomey['api']` (not exported from the module under test); the
// bare `vi.fn()` infers `Mock<Procedure>`, which is not assignable to this
// precise call signature, so the mock is annotated to the real shape.
type ReporterApi = (method: 'POST', path: string, body?: unknown) => Promise<unknown>;
type ApiMock = ReturnType<typeof vi.fn<ReporterApi>>;

const makeHomey = (api: ApiMock): { api: ReporterApi } => ({ api });

describe('widgetClientLog reporter', () => {
  it('POSTs an error entry to the widget /log endpoint with a normalized detail', async () => {
    const api = vi.fn().mockResolvedValue(undefined);
    const now = 1_000;
    const reporter = createWidgetErrorReporter({
      widget: 'headroom',
      getHomey: () => makeHomey(api),
      now: () => now,
    });

    reporter.report('error', 'Failed to load headroom widget', new Error('boom'));
    await flushMicrotasks();

    expect(api).toHaveBeenCalledTimes(1);
    const [method, path, body] = api.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/log');
    expect(body).toMatchObject({
      level: 'error',
      widget: 'headroom',
      message: 'Failed to load headroom widget',
      timestamp: 1_000,
    });
    expect(String(body.detail)).toContain('boom');
  });

  it('is a no-op in preview/harness when there is no Homey client', async () => {
    const api = vi.fn().mockResolvedValue(undefined);
    const reporter = createWidgetErrorReporter({
      widget: 'headroom',
      getHomey: () => null,
      now: () => 0,
    });

    reporter.report('error', 'Failed to load headroom widget', new Error('boom'));
    await flushMicrotasks();

    expect(api).not.toHaveBeenCalled();
  });

  it('throttles an identical message inside the suppression window, then lets it through after', async () => {
    const api = vi.fn().mockResolvedValue(undefined);
    let now = 0;
    const reporter = createWidgetErrorReporter({
      widget: 'plan_budget',
      getHomey: () => makeHomey(api),
      now: () => now,
    });

    reporter.report('error', 'same', new Error('a'));
    now = 30_000; // within the 60 s window
    reporter.report('error', 'same', new Error('b'));
    await flushMicrotasks();
    expect(api).toHaveBeenCalledTimes(1);

    now = 61_000; // past the window
    reporter.report('error', 'same', new Error('c'));
    await flushMicrotasks();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('queues a report when the app is unreachable and delivers it on the next flush', async () => {
    const api = vi.fn().mockRejectedValueOnce(new Error('App is not available'));
    let now = 0;
    const reporter = createWidgetErrorReporter({
      widget: 'smart_tasks',
      getHomey: () => makeHomey(api),
      now: () => now,
    });

    // First send fails → entry is queued, not lost.
    reporter.report('error', 'Failed to load smart_tasks widget', new Error('down'));
    await flushMicrotasks();
    expect(api).toHaveBeenCalledTimes(1);

    // App recovers; a successful load flushes the backlog.
    api.mockResolvedValue(undefined);
    now = 10_000;
    reporter.flush();
    await flushMicrotasks();
    expect(api).toHaveBeenCalledTimes(2);
    expect(api.mock.calls[1][2]).toMatchObject({
      message: 'Failed to load smart_tasks widget',
      widget: 'smart_tasks',
    });
  });

  it('collapses repeated identical failures queued across the window into one backlog entry', async () => {
    const api = vi.fn().mockRejectedValue(new Error('App is not available'));
    let now = 0;
    const reporter = createWidgetErrorReporter({
      widget: 'headroom',
      getHomey: () => makeHomey(api),
      now: () => now,
    });

    reporter.report('error', 'Failed to load headroom widget', new Error('1'));
    await flushMicrotasks();
    now = 61_000; // past throttle so the same message is accepted again
    reporter.report('error', 'Failed to load headroom widget', new Error('2'));
    await flushMicrotasks();

    // Both failed to POST; the backlog must hold ONE coalesced entry, so a later
    // flush against a recovered app emits a single line, not a burst.
    api.mockResolvedValue(undefined);
    now = 120_000;
    reporter.flush();
    await flushMicrotasks();

    const logPosts = api.mock.calls.filter(([, path]) => path === '/log');
    const delivered = logPosts.length; // 2 failed attempts + 1 successful drain
    expect(delivered).toBe(3);
  });

  it('widgetErrorReporter binds the widget id and late-bound client', async () => {
    const api = vi.fn().mockResolvedValue(undefined);
    let homey: { api: ReporterApi } | null = null;
    const reporter = widgetErrorReporter('starvation_rescue', () => homey);

    // No client yet → dropped.
    reporter.report('error', 'msg');
    await flushMicrotasks();
    expect(api).not.toHaveBeenCalled();

    // Client arrives later (bootstrap) → reported under the bound id.
    homey = makeHomey(api);
    reporter.report('error', 'msg2');
    await flushMicrotasks();
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0][2]).toMatchObject({ widget: 'starvation_rescue', message: 'msg2' });
  });
});
