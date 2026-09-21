const savePriorities = vi.fn();
const renderPriorities = vi.fn();
const isPriorityContextCurrent = vi.fn();

vi.mock('../src/ui/modes.ts', () => ({
  renderPriorities: (...args: unknown[]) => renderPriorities(...args),
}));
vi.mock('../src/ui/modePrioritySave.ts', () => ({
  isPriorityContextCurrent: (...args: unknown[]) => isPriorityContextCurrent(...args),
  savePriorities: (...args: unknown[]) => savePriorities(...args),
}));

const installModesPage = () => {
  document.body.innerHTML = `
    <div id="priority-unplaced" hidden><md-text-button id="priority-keep-order"></md-text-button></div>
    <ul id="priority-list">
      <li class="device-row" data-device-id="bedroom">
        <md-filled-text-field class="mode-target-input" data-device-id="bedroom"></md-filled-text-field>
      </li>
      <li class="device-row" data-device-id="pool"></li>
    </ul>`;
};

const load = async () => {
  const [{ state }, { initModePriorityConfirm }, facts] = await Promise.all([
    import('../src/ui/state.ts'),
    import('../src/ui/modePriorityConfirm.ts'),
    import('../src/ui/setupPathFacts.ts'),
  ]);
  state.editingMode = 'Home';
  state.loadedModeHomeId = 'main';
  state.capacityPriorities = { Home: {} };
  const onChange = vi.fn();
  facts.onSetupPathChange(onChange);
  initModePriorityConfirm();
  return { state, onChange };
};

const clickKeep = async () => {
  document.getElementById('priority-keep-order')?.dispatchEvent(new Event('click'));
  await vi.waitFor(() => expect(savePriorities).toHaveBeenCalled());
  await Promise.resolve();
};

describe('Keep this order', () => {
  beforeEach(() => {
    vi.resetModules();
    savePriorities.mockReset();
    renderPriorities.mockReset();
    isPriorityContextCurrent.mockReset().mockReturnValue(true);
    installModesPage();
  });

  it('shows the notice while a listed device has no place, and hides it once all do', async () => {
    const { state } = await load();
    expect(document.getElementById('priority-unplaced')?.hidden).toBe(false);

    savePriorities.mockImplementation(async () => {
      state.capacityPriorities.Home = { bedroom: 1, pool: 2 };
      return {
        status: 'saved', homeId: 'main', mode: 'Home', deviceIds: ['bedroom', 'pool'],
      };
    });
    await clickKeep();
    expect(document.getElementById('priority-unplaced')?.hidden).toBe(true);
  });

  it('does not count an order the write failed to save', async () => {
    const { state, onChange } = await load();
    savePriorities.mockResolvedValue({ status: 'not-saved' });
    await clickKeep();

    expect(state.capacityPriorities).toEqual({ Home: {} });
    expect(document.getElementById('priority-unplaced')?.hidden).toBe(false);
    expect(renderPriorities).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores a saved result after the visible mode changes', async () => {
    const { state } = await load();
    let resolveSave!: (value: {
      status: 'saved'; homeId: string; mode: string; deviceIds: string[];
    }) => void;
    savePriorities.mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));

    document.getElementById('priority-keep-order')?.dispatchEvent(new Event('click'));
    await vi.waitFor(() => expect(savePriorities).toHaveBeenCalledOnce());
    state.editingMode = 'Away';
    isPriorityContextCurrent.mockReturnValue(false);
    resolveSave({
      status: 'saved', homeId: 'main', mode: 'Home', deviceIds: ['bedroom', 'pool'],
    });
    await Promise.resolve();

    expect(state.capacityPriorities).toEqual({ Home: {} });
    expect(renderPriorities).not.toHaveBeenCalled();
  });
});
