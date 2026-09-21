const savePriorities = vi.fn();
const renderPriorities = vi.fn();
const getSettingFresh = vi.fn();

vi.mock('../src/ui/modes.ts', () => ({
  savePriorities: (...args: unknown[]) => savePriorities(...args),
  renderPriorities: (...args: unknown[]) => renderPriorities(...args),
}));
vi.mock('../src/ui/homey.ts', async () => ({
  ...(await vi.importActual<typeof import('../src/ui/homey.ts')>('../src/ui/homey.ts')),
  getSettingFresh: (...args: unknown[]) => getSettingFresh(...args),
}));

const installModesPage = () => {
  document.body.innerHTML = `
    <div id="priority-unplaced" hidden><md-text-button id="priority-keep-order"></md-text-button></div>
    <ul id="priority-list">
      <li data-device-id="bedroom"></li>
      <li data-device-id="pool"></li>
    </ul>`;
};

const load = async () => {
  const [{ state }, { initModePriorityConfirm }, facts] = await Promise.all([
    import('../src/ui/state.ts'),
    import('../src/ui/modePriorityConfirm.ts'),
    import('../src/ui/setupPathFacts.ts'),
  ]);
  state.editingMode = 'Home';
  state.capacityPriorities = { Home: {} };
  const onChange = vi.fn();
  facts.onSetupPathChange(onChange);
  initModePriorityConfirm();
  return { state };
};

const clickKeep = async () => {
  document.getElementById('priority-keep-order')?.dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(renderPriorities).toHaveBeenCalled());
};

describe('Keep this order', () => {
  beforeEach(() => {
    vi.resetModules();
    savePriorities.mockReset();
    renderPriorities.mockReset();
    getSettingFresh.mockReset();
    installModesPage();
  });

  it('shows the notice while a listed device has no place, and hides it once all do', async () => {
    const { state } = await load();
    expect(document.getElementById('priority-unplaced')?.hidden).toBe(false);

    // The production save places every listed device in `state` before it writes.
    savePriorities.mockImplementation(async () => { state.capacityPriorities.Home = { bedroom: 1, pool: 2 }; });
    getSettingFresh.mockResolvedValue({ Home: { bedroom: 1, pool: 2 } });
    await clickKeep();
    expect(document.getElementById('priority-unplaced')?.hidden).toBe(true);
  });

  it('does not count an order the write failed to save', async () => {
    const { state } = await load();
    // `savePriorities` reports a rejected write with a toast and then RESOLVES,
    // with `state` already updated. Homey still holds the old, empty order.
    savePriorities.mockImplementation(async () => { state.capacityPriorities.Home = { bedroom: 1, pool: 2 }; });
    getSettingFresh.mockResolvedValue({ Home: {} });
    await clickKeep();

    expect(state.capacityPriorities).toEqual({ Home: {} });
    expect(document.getElementById('priority-unplaced')?.hidden).toBe(false);
  });

  it('treats an unreadable read-back as not saved', async () => {
    const { state } = await load();
    savePriorities.mockImplementation(async () => { state.capacityPriorities.Home = { bedroom: 1, pool: 2 }; });
    getSettingFresh.mockRejectedValue(new Error('bridge'));
    await clickKeep();
    expect(state.capacityPriorities).toEqual({ Home: {} });
    expect(document.getElementById('priority-unplaced')?.hidden).toBe(false);
  });
});
