export {};
// Mock Homey.Device
class MockDevice {
  private capabilities: Set<string> = new Set();
  private capabilityValues: Map<string, unknown> = new Map();
  private settingsListeners: Map<string, Array<(key: string) => void>> = new Map();
  private mockSettings: Map<string, unknown> = new Map();

  homey = {
    settings: {
      get: (key: string) => this.mockSettings.get(key),
      on: (event: string, callback: (key: string) => void) => {
        if (!this.settingsListeners.has(event)) {
          this.settingsListeners.set(event, []);
        }
        this.settingsListeners.get(event)!.push(callback);
      },
    },
  };

  // Helper to set mock settings and trigger listeners
  setMockSetting(key: string, value: unknown): void {
    this.mockSettings.set(key, value);
    const listeners = this.settingsListeners.get('set') || [];
    listeners.forEach((cb) => cb(key));
  }

  // Simulate having a capability
  addCapability(capabilityId: string): Promise<void> {
    this.capabilities.add(capabilityId);
    return Promise.resolve();
  }

  hasCapability(capabilityId: string): boolean {
    return this.capabilities.has(capabilityId);
  }

  async setCapabilityValue(capabilityId: string, value: unknown): Promise<void> {
    if (!this.capabilities.has(capabilityId)) {
      const error = new Error(`Invalid Capability: ${capabilityId}`) as Error & { statusCode: number };
      error.statusCode = 404;
      throw error;
    }
    this.capabilityValues.set(capabilityId, value);
  }

  getCapabilityValue(capabilityId: string): unknown {
    return this.capabilityValues.get(capabilityId);
  }

  error(..._args: unknown[]): void {
    // Capture errors for testing
  }
}

// The actual device implementation (we'll test against this logic)
class PelsInsightsDevice extends MockDevice {
  async onInit(): Promise<void> {
    await this.updateMode(this.homey.settings.get('operating_mode') as string || 'home');
    await this.updateShortfall(this.homey.settings.get('capacity_in_shortfall') as boolean || false);

    this.homey.settings.on('set', async (key) => {
      if (key === 'operating_mode') {
        await this.updateMode(this.homey.settings.get('operating_mode') as string || 'home');
      }
      if (key === 'capacity_in_shortfall') {
        await this.updateShortfall(this.homey.settings.get('capacity_in_shortfall') as boolean || false);
      }
    });
  }

  async updateMode(mode: string): Promise<void> {
    if (typeof mode !== 'string' || !mode.trim()) return;
    try {
      await this.setCapabilityValue('pels_insights', mode);
    } catch (error) {
      this.error('Failed to update pels insights', error);
    }
  }

  async updateShortfall(inShortfall: boolean): Promise<void> {
    try {
      await this.setCapabilityValue('alarm_generic', Boolean(inShortfall));
    } catch (error) {
      this.error('Failed to update shortfall alarm', error);
    }
  }
}

// Device with fix - adds capability if missing
class PelsInsightsDeviceFixed extends MockDevice {
  async onInit(): Promise<void> {
    // Add alarm_generic capability if missing (for devices created before this capability was added)
    if (!this.hasCapability('alarm_generic')) {
      await this.addCapability('alarm_generic');
    }

    await this.updateMode(this.homey.settings.get('operating_mode') as string || 'home');
    await this.updateShortfall(this.homey.settings.get('capacity_in_shortfall') as boolean || false);

    this.homey.settings.on('set', async (key) => {
      if (key === 'operating_mode') {
        await this.updateMode(this.homey.settings.get('operating_mode') as string || 'home');
      }
      if (key === 'capacity_in_shortfall') {
        await this.updateShortfall(this.homey.settings.get('capacity_in_shortfall') as boolean || false);
      }
    });
  }

  async updateMode(mode: string): Promise<void> {
    if (typeof mode !== 'string' || !mode.trim()) return;
    try {
      await this.setCapabilityValue('pels_insights', mode);
    } catch (error) {
      this.error('Failed to update pels insights', error);
    }
  }

  async updateShortfall(inShortfall: boolean): Promise<void> {
    try {
      await this.setCapabilityValue('alarm_generic', Boolean(inShortfall));
    } catch (error) {
      this.error('Failed to update shortfall alarm', error);
    }
  }
}

describe('PelsInsightsDevice', () => {
  describe('updateShortfall - current behavior (fails for old devices)', () => {
    it('should fail to set alarm_generic when capability is missing', async () => {
      const device = new PelsInsightsDevice();
      // Simulate old device that only has pels_insights capability
      await device.addCapability('pels_insights');

      // This should fail silently (error is caught) but capability value won't be set
      await device.updateShortfall(true);

      // Capability value should not be set since capability doesn't exist
      expect(device.getCapabilityValue('alarm_generic')).toBeUndefined();
    });

    it('should work when device has alarm_generic capability', async () => {
      const device = new PelsInsightsDevice();
      await device.addCapability('pels_insights');
      await device.addCapability('alarm_generic');

      await device.updateShortfall(true);

      expect(device.getCapabilityValue('alarm_generic')).toBe(true);
    });
  });

  describe('updateShortfall - fixed behavior', () => {
    it('should add alarm_generic capability on init if missing', async () => {
      const device = new PelsInsightsDeviceFixed();
      // Simulate old device that only has pels_insights capability
      await device.addCapability('pels_insights');
      // Note: alarm_generic is NOT added - simulating old device

      await device.onInit();

      // After init, the capability should be added
      expect(device.hasCapability('alarm_generic')).toBe(true);
    });

    it('should successfully set alarm_generic after capability is added', async () => {
      const device = new PelsInsightsDeviceFixed();
      await device.addCapability('pels_insights');

      await device.onInit();
      await device.updateShortfall(true);

      expect(device.getCapabilityValue('alarm_generic')).toBe(true);
    });

    it('should not duplicate capability if already present', async () => {
      const device = new PelsInsightsDeviceFixed();
      await device.addCapability('pels_insights');
      await device.addCapability('alarm_generic');

      // onInit should not throw even if capability already exists
      await device.onInit();

      expect(device.hasCapability('alarm_generic')).toBe(true);
    });
  });

  describe('updateMode', () => {
    it('should set pels_insights capability', async () => {
      const device = new PelsInsightsDevice();
      await device.addCapability('pels_insights');
      await device.addCapability('alarm_generic');

      await device.updateMode('away');

      expect(device.getCapabilityValue('pels_insights')).toBe('away');
    });

    it('should not set empty mode', async () => {
      const device = new PelsInsightsDevice();
      await device.addCapability('pels_insights');
      await device.addCapability('alarm_generic');

      await device.updateMode('');

      expect(device.getCapabilityValue('pels_insights')).toBeUndefined();
    });

    it('should not set whitespace-only mode', async () => {
      const device = new PelsInsightsDevice();
      await device.addCapability('pels_insights');
      await device.addCapability('alarm_generic');

      await device.updateMode('   ');

      expect(device.getCapabilityValue('pels_insights')).toBeUndefined();
    });
  });

  describe('settings listener', () => {
    it('should update shortfall when setting changes', async () => {
      const device = new PelsInsightsDeviceFixed();
      await device.addCapability('pels_insights');

      await device.onInit();

      // Trigger setting change
      device.setMockSetting('capacity_in_shortfall', true);

      // Give async listener time to execute
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(device.getCapabilityValue('alarm_generic')).toBe(true);
    });

    it('should update mode when setting changes', async () => {
      const device = new PelsInsightsDeviceFixed();
      await device.addCapability('pels_insights');

      await device.onInit();

      device.setMockSetting('operating_mode', 'night');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(device.getCapabilityValue('pels_insights')).toBe('night');
    });
  });
});
