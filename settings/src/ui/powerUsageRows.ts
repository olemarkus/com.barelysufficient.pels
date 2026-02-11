import { createUsageBar } from './components';
import { setTooltip } from './tooltips';
import { formatTimeInTimeZone } from './timezone';
import type { UsageDayEntry } from './usageDayView';

type PowerUsageEntry = UsageDayEntry;

const createTimeLabel = (date: Date, timeZone: string): string => {
  const start = date;
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const startText = formatTimeInTimeZone(start, { hour: '2-digit', minute: '2-digit' }, timeZone);
  const endText = formatTimeInTimeZone(end, { hour: '2-digit', minute: '2-digit' }, timeZone);
  return `${startText}–${endText}`;
};

const buildPowerMeterTitle = (entry: PowerUsageEntry, budget: number | null): string => {
  const lines = [];
  if (budget !== null) {
    lines.push(`${entry.kWh > budget ? 'Over' : 'Under'} cap: ${entry.kWh.toFixed(2)} / ${budget.toFixed(2)} kWh`);
  } else {
    lines.push(`Energy ${entry.kWh.toFixed(2)} kWh`);
  }
  if (typeof entry.controlledKWh === 'number' && typeof entry.uncontrolledKWh === 'number') {
    lines.push(`Controlled ${entry.controlledKWh.toFixed(2)} kWh`);
    lines.push(`Uncontrolled ${entry.uncontrolledKWh.toFixed(2)} kWh`);
  }
  if (entry.unreliable) lines.push('Unreliable data');
  return lines.join(' · ');
};

const createPowerMeter = (entry: PowerUsageEntry, budget: number | null): HTMLElement => (
  createUsageBar({
    value: entry.kWh,
    max: budget ?? entry.kWh,
    minFillPct: 4,
    className: 'power-meter usage-bar--lg',
    fillClassName: budget && entry.kWh > budget
      ? 'usage-bar__fill--accent power-meter__fill--alert'
      : 'usage-bar__fill--accent',
    labelClassName: 'power-meter__label',
    labelText: budget !== null
      ? `${entry.kWh.toFixed(2)} / ${budget.toFixed(2)} kWh`
      : `${entry.kWh.toFixed(2)} kWh`,
    title: buildPowerMeterTitle(entry, budget),
  })
);

export const createPowerRow = (entry: PowerUsageEntry, timeZone: string): HTMLElement => {
  const row = document.createElement('li');
  row.className = 'usage-row usage-row--detail';

  const label = document.createElement('div');
  label.className = 'usage-row__label';
  label.textContent = createTimeLabel(entry.hour, timeZone);

  const budget = typeof entry.budgetKWh === 'number' && entry.budgetKWh > 0 ? entry.budgetKWh : null;
  const meter = createPowerMeter(entry, budget);
  meter.classList.add('usage-row__bar');

  const value = document.createElement('div');
  value.className = 'usage-row__value';
  value.textContent = `${entry.kWh.toFixed(2)} kWh`;

  if (entry.unreliable) {
    row.classList.add('usage-row--warn');
    setTooltip(row, 'Unreliable data');
  }

  row.append(label, meter, value);
  return row;
};
