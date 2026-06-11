import { handleWidgetClientLog } from '../../widgets/_shared/widgetClientLogApi';

const makeCtx = (body: unknown) => {
  const error = vi.fn();
  const log = vi.fn();
  return { ctx: { homey: { app: { error, log } }, body }, error, log };
};

const validEntry = (over: Record<string, unknown> = {}) => ({
  level: 'error',
  widget: 'headroom',
  message: 'Failed to load headroom widget',
  detail: 'Error: boom',
  timestamp: 1_000,
  ...over,
});

describe('handleWidgetClientLog', () => {
  it('routes an error entry to app.error with the widget-tagged message and a detail-bearing Error', () => {
    const { ctx, error, log } = makeCtx(validEntry());
    const result = handleWidgetClientLog('headroom', ctx);

    expect(result).toEqual({ ok: true });
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const [message, errObj] = error.mock.calls[0];
    expect(message).toBe('Widget (headroom): Failed to load headroom widget');
    expect(errObj).toBeInstanceOf(Error);
    expect((errObj as Error).message).toBe('Error: boom');
  });

  it('routes a warn entry to app.log with a Warning prefix', () => {
    const { ctx, error, log } = makeCtx(validEntry({ level: 'warn', detail: undefined }));
    const result = handleWidgetClientLog('plan_budget', ctx);

    expect(result).toEqual({ ok: true });
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Warning: Widget (headroom): Failed to load headroom widget');
  });

  it('routes an info entry to app.log', () => {
    const { ctx, error, log } = makeCtx(validEntry({ level: 'info', message: 'hello', detail: undefined }));
    handleWidgetClientLog('headroom', ctx);

    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Widget (headroom): hello');
  });

  it('rejects an invalid payload without throwing', () => {
    const { ctx, error, log } = makeCtx({ level: 'nope', message: 42 });
    const result = handleWidgetClientLog('starvation_rescue', ctx);

    expect(result).toEqual({ ok: false });
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Widget starvation_rescue log API called without a valid payload');
  });

  it('does not throw when the app handle is absent (app not yet available)', () => {
    const result = handleWidgetClientLog('headroom', { homey: {}, body: validEntry() });
    expect(result).toEqual({ ok: true });
  });
});
