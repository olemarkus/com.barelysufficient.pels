describe('settings UI variant preference', () => {
  afterEach(() => {
    vi.resetModules();
    document.body.dataset.uiVariant = '';
    document.body.className = '';
  });

  it('keeps the toggle effective for the session when storage is sandboxed', async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Storage is unavailable in this context.', 'SecurityError');
      },
    });

    try {
      const {
        applyStoredOverviewRedesignPreference,
        getStoredOverviewRedesignPreference,
        setStoredOverviewRedesignPreference,
      } = await import('../src/ui/uiVariant.ts');

      setStoredOverviewRedesignPreference(true);

      expect(getStoredOverviewRedesignPreference()).toBe(true);
      expect(applyStoredOverviewRedesignPreference(true)).toBe('redesign');
      expect(document.body.dataset.uiVariant).toBe('redesign');
      expect(document.body.classList.contains('overview-redesign-enabled')).toBe(true);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
      } else {
        delete (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage;
      }
    }
  });
});
