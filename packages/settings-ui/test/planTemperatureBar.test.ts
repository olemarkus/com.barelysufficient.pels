import { resolveTemperatureBar } from '../../shared-domain/src/planTemperatureBar.ts';

describe('resolveTemperatureBar', () => {
  it('anchors the scale at target and fills left when below target', () => {
    const view = resolveTemperatureBar({
      controlModel: 'temperature_target',
      currentTemperature: 21,
      currentTarget: 22,
      plannedTarget: 22,
      plannedState: 'keep',
    });

    expect(view).toMatchObject({
      label: '21.0° · 1.0° below target',
      targetLabel: 'target 22.0°',
      rangeLabel: '±2.0°',
      currentPct: 25,
      targetPct: 50,
      fillLeftPct: 25,
      fillWidthPct: 25,
      progressTone: 'approaching',
    });
  });

  it('fills right and uses an above-target tone when current temperature is over target', () => {
    const view = resolveTemperatureBar({
      controlModel: 'temperature_target',
      currentTemperature: 23,
      currentTarget: 22,
      plannedTarget: 22,
      plannedState: 'keep',
    });

    expect(view).toMatchObject({
      label: '23.0° · 1.0° above target',
      targetLabel: 'target 22.0°',
      rangeLabel: '±2.0°',
      currentPct: 75,
      targetPct: 50,
      fillLeftPct: 50,
      fillWidthPct: 25,
      progressTone: 'above_target',
    });
  });

  it('expands the centered scale to include setback temperatures', () => {
    const view = resolveTemperatureBar({
      controlModel: 'temperature_target',
      currentTemperature: 21,
      currentTarget: 22,
      plannedTarget: 22,
      shedTemperature: 18,
      plannedState: 'shed',
    });

    expect(view).toMatchObject({
      rangeLabel: '±4.0°',
      currentPct: 37.5,
      targetPct: 50,
      setbackPct: 0,
      progressTone: 'held',
    });
  });
});
