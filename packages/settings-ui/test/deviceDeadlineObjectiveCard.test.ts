import { h, render } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { DeviceDeadlineObjectiveCard } from '../src/ui/views/DeviceDeadlineObjectiveCard.tsx';

describe('DeviceDeadlineObjectiveCard', () => {
  it('submits a soft temperature deadline target', () => {
    const mount = document.createElement('div');
    const onSave = vi.fn();

    render(h(DeviceDeadlineObjectiveCard, {
      deviceName: 'Connected 300',
      entry: {
          enabled: true,
        kind: 'temperature',
        enforcement: 'soft',
        targetTemperatureC: 65,
        deadlineLocalTime: '08:00',
      },
      planHref: './deadline-plan.html?deviceId=connected-300',
      target: { id: 'target_temperature', unit: 'C', min: 0, max: 95, step: 0.5 },
      saving: false,
      error: null,
      onSave,
      onClear: vi.fn(),
    }),
      mount,
    );

    const temperatureInput = mount.querySelector('input[name="targetTemperatureC"]') as HTMLInputElement;
    const timeInput = mount.querySelector('input[name="deadlineLocalTime"]') as HTMLInputElement;
    temperatureInput.value = '70';
    temperatureInput.dispatchEvent(new Event('input', { bubbles: true }));
    timeInput.value = '07:30';
    timeInput.dispatchEvent(new Event('input', { bubbles: true }));

    mount.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(onSave).toHaveBeenCalledWith({
      enabled: true,
      targetTemperatureC: 70,
      deadlineLocalTime: '07:30',
    });
    expect((mount.querySelector('a[href*="deviceId=connected-300"]') as HTMLAnchorElement | null)?.textContent)
      .toContain('View plan');
  });

  it('resets dirty form values when another device entry is rendered in the same mount', () => {
    const mount = document.createElement('div');
    const onSave = vi.fn();
    const renderCard = (deviceName: string, targetTemperatureC: number, deadlineLocalTime: string) => {
      render(h(DeviceDeadlineObjectiveCard, {
        key: deviceName,
        deviceName,
        entry: {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC,
          deadlineLocalTime,
        },
        planHref: `./deadline-plan.html?deviceId=${deviceName}`,
        target: { id: 'target_temperature', unit: 'C', min: 0, max: 95, step: 0.5 },
        saving: false,
        error: null,
        onSave,
        onClear: vi.fn(),
      }), mount);
    };

    renderCard('Heater A', 60, '06:00');
    const dirtyTemperature = mount.querySelector('input[name="targetTemperatureC"]') as HTMLInputElement;
    dirtyTemperature.value = '90';
    dirtyTemperature.dispatchEvent(new Event('input', { bubbles: true }));

    renderCard('Heater B', 50, '08:00');
    mount.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(onSave).toHaveBeenLastCalledWith({
      enabled: true,
      targetTemperatureC: 50,
      deadlineLocalTime: '08:00',
    });
  });
});
