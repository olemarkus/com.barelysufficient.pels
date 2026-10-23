// The rescue chip's gate rides the plan it is drawn with
// (`SettingsUiPlanSnapshot.rescuableDeviceIds`), so the Overview reads no gate
// of its own. A rescue the WebView just created hides the device's chip until a
// plan stops listing it: a plan built before the create landed still lists it.
const callApi = vi.fn();
vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApi(...args),
}));
vi.mock('../src/ui/toast.ts', () => ({ showToast: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn().mockResolvedValue(undefined) }));

const {
  applyPlanRescueGate,
  createStarvationRescue,
  isStarvationRescuable,
} = await import('../src/ui/starvationRescue.ts');

beforeEach(() => {
  callApi.mockReset();
  applyPlanRescueGate([]);
});

describe('starvation rescue gate', () => {
  it('offers the rescue only on the devices the rendered plan lists', () => {
    applyPlanRescueGate(['heater-1']);
    expect(isStarvationRescuable('heater-1')).toBe(true);
    expect(isStarvationRescuable('heater-2')).toBe(false);

    applyPlanRescueGate([]);
    expect(isStarvationRescuable('heater-1')).toBe(false);
  });

  it('keeps a just-rescued device hidden until a plan stops listing it', async () => {
    applyPlanRescueGate(['heater-1', 'heater-2']);
    callApi.mockResolvedValueOnce({ ok: true, runsCurrentHour: true });

    await expect(createStarvationRescue('heater-1')).resolves.toEqual({ ok: true, runsCurrentHour: true });
    expect(isStarvationRescuable('heater-1')).toBe(false);
    expect(isStarvationRescuable('heater-2')).toBe(true);

    // A plan built before the create landed.
    applyPlanRescueGate(['heater-1', 'heater-2']);
    expect(isStarvationRescuable('heater-1')).toBe(false);

    // The server caught up; a later episode can offer the rescue again.
    applyPlanRescueGate(['heater-2']);
    applyPlanRescueGate(['heater-1', 'heater-2']);
    expect(isStarvationRescuable('heater-1')).toBe(true);
  });

  it('keeps offering the rescue after a rejected create', async () => {
    applyPlanRescueGate(['heater-1']);
    callApi.mockResolvedValueOnce({ ok: false, reason: 'not_rescuable' });

    await expect(createStarvationRescue('heater-1')).resolves.toEqual({ ok: false });
    expect(isStarvationRescuable('heater-1')).toBe(true);
  });
});
