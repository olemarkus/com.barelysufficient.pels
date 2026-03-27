import path from 'path';
import { fileURLToPath } from 'url';
import { chromium, firefox } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock devices for demonstration
const mockDevices = [
  { id: 'dev-1', name: 'Living Room Heater', priority: 1 },
  { id: 'dev-2', name: 'Kitchen Radiator', priority: 2 },
  { id: 'dev-3', name: 'Bedroom Heater', priority: 3 },
  { id: 'dev-4', name: 'Bathroom Floor Heat', priority: 4 },
  { id: 'dev-5', name: 'Office Heater', priority: 5 },
  { id: 'dev-6', name: 'Guest Room Radiator', priority: 6 },
];

// Mock plan data
const mockPlan = {
  meta: {
    totalKw: 4.2,
    softLimitKw: 5.0,
    headroomKw: 0.8,
    usedKWh: 2.1,
    budgetKWh: 5.0,
  },
  devices: [
    {
      id: 'dev-1', name: 'Living Room Heater', priority: 1, currentTemperature: 21.5, currentTarget: 22, plannedTarget: 22, currentState: 'heating', plannedState: 'keep', reason: 'Temperature stable',
    },
    {
      id: 'dev-2', name: 'Kitchen Radiator', priority: 2, currentTemperature: 20.8, currentTarget: 21, plannedTarget: 21, currentState: 'heating', plannedState: 'keep', reason: 'Below target',
    },
    {
      id: 'dev-3', name: 'Bedroom Heater', priority: 3, currentTemperature: 19.2, currentTarget: 20, plannedTarget: 18, currentState: 'heating', plannedState: 'shed', reason: 'Capacity limit reached',
    },
    {
      id: 'dev-4', name: 'Bathroom Floor Heat', priority: 4, currentTemperature: 23.1, currentTarget: 24, plannedTarget: 22, currentState: 'idle', plannedState: 'shed', reason: 'Price optimization',
    },
    {
      id: 'dev-5', name: 'Office Heater', priority: 5, currentTemperature: 18.5, currentTarget: 20, plannedTarget: 18, currentState: 'heating', plannedState: 'shed', reason: 'Low priority device',
    },
    {
      id: 'dev-6', name: 'Guest Room Radiator', priority: 6, currentTemperature: 17.0, currentTarget: 18, plannedTarget: 16, currentState: 'idle', plannedState: 'shed', reason: 'Room unoccupied',
    },
  ],
};

// Mock power usage data
const mockPowerUsage = [];
const now = new Date();
for (let index = 5; index >= 0; index -= 1) {
  const hour = new Date(now);
  hour.setHours(hour.getHours() - index, 0, 0, 0);
  mockPowerUsage.push({
    hour: hour.toISOString(),
    kWh: (Math.random() * 2 + 1).toFixed(3),
  });
}

// Mock price data
const mockPrices = [];
for (let index = 0; index < 24; index += 1) {
  const hour = new Date(now);
  hour.setHours(hour.getHours() + index, 0, 0, 0);
  const basePrice = 50 + Math.random() * 100;
  mockPrices.push({
    startsAt: hour.toISOString(),
    total: basePrice,
    isCheap: basePrice < 70,
    isExpensive: basePrice > 120,
  });
}

const tabs = ['overview', 'devices', 'modes', 'budget', 'usage', 'price', 'advanced'];

const useFirefox = process.argv.includes('firefox');
const browserType = useFirefox ? firefox : chromium;
const browserName = useFirefox ? 'firefox' : 'chrome';

const browser = await browserType.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

try {
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
  });
  const page = await context.newPage();
  const htmlPath = `file://${path.join(__dirname, 'settings', 'index.html')}`;

  for (const tab of tabs) {
    await page.goto(htmlPath, { waitUntil: 'domcontentloaded' });

    await page.evaluate((tabName, devices, plan, powerUsage, prices) => {
      document.querySelectorAll('.panel').forEach((element) => {
        element.classList.add('hidden');
      });

      const panel = document.getElementById(`${tabName}-panel`);
      if (panel) {
        panel.classList.remove('hidden');
      }

      document.querySelectorAll('.tab').forEach((button) => {
        button.classList.remove('active');
        if (button instanceof HTMLElement && button.dataset.tab === tabName) {
          button.classList.add('active');
        }
      });

      const el = (tag, className, text) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text) element.textContent = text;
        return element;
      };

      if (tabName === 'devices') {
        const list = document.getElementById('device-list');
        const empty = document.getElementById('empty-state');
        if (list && empty) {
          empty.hidden = true;
          list.innerHTML = '';
          devices.forEach((device) => {
            const row = el('div', 'device-row control-row');
            const name = el('div', 'device-row__name', device.name);
            const ctrl = el('div', 'device-row__target control-row__inputs');

            const ctrlLabel = el('label', 'checkbox-field-inline');
            const ctrlInput = document.createElement('input');
            ctrlInput.type = 'checkbox';
            ctrlInput.checked = true;
            ctrlLabel.append(ctrlInput, el('span', '', 'Controllable'));

            const priceLabel = el('label', 'checkbox-field-inline');
            const priceInput = document.createElement('input');
            priceInput.type = 'checkbox';
            priceInput.checked = device.priority <= 3;
            priceLabel.append(priceInput, el('span', '', 'Price opt'));

            ctrl.append(ctrlLabel, priceLabel);
            row.append(name, ctrl);
            list.appendChild(row);
          });
        }
      }

      if (tabName === 'overview') {
        const list = document.getElementById('plan-list');
        const empty = document.getElementById('plan-empty');
        const meta = document.getElementById('plan-meta');
        if (list && empty && meta) {
          empty.hidden = true;
          const m = plan.meta;
          meta.innerHTML = `<div>Now ${m.totalKw.toFixed(1)}kW / Limit ${m.softLimitKw.toFixed(1)}kW</div><div>${m.headroomKw.toFixed(1)}kW available · This hour: ${m.usedKWh.toFixed(2)} of ${m.budgetKWh.toFixed(1)}kWh</div>`;
          list.innerHTML = '';
          plan.devices.forEach((dev) => {
            const row = el('div', 'device-row');
            const metaWrap = el('div', 'device-row__target plan-row__meta');
            const name = el('div', 'device-row__name', dev.name);

            const tempLine = el('div', 'plan-meta-line');
            const targetChanging = dev.plannedTarget !== dev.currentTarget;
            const targetText = targetChanging ? `${dev.currentTarget}° → ${dev.plannedTarget}°` : `${dev.currentTarget}°`;
            tempLine.innerHTML = `<span class="plan-label">Temperature</span><span>${dev.currentTemperature.toFixed(1)}° / target ${targetText}</span>`;

            const powerLine = el('div', 'plan-meta-line');
            const plannedPower = dev.plannedState === 'shed'
              ? 'off'
              : dev.plannedState === 'inactive'
                ? 'off'
                : dev.currentState;
            const powerChanging = dev.currentState !== plannedPower;
            const powerText = powerChanging ? `${dev.currentState} → ${plannedPower}` : dev.currentState;
            powerLine.innerHTML = `<span class="plan-label">Power</span><span>${powerText}</span>`;

            const reasonLine = el('div', 'plan-meta-line');
            reasonLine.innerHTML = `<span class="plan-label">Reason</span><span>${dev.reason}</span>`;

            metaWrap.append(name, tempLine, powerLine, reasonLine);
            row.append(metaWrap);
            list.appendChild(row);
          });
        }
      }

      if (tabName === 'modes') {
        const list = document.getElementById('priority-list');
        const empty = document.getElementById('priority-empty');
        if (list && empty) {
          empty.hidden = true;
          list.innerHTML = '';
          devices.forEach((device, index) => {
            const row = el('div', 'device-row draggable mode-row');
            row.draggable = true;

            const handle = el('span', 'drag-handle', '↕');
            const name = el('div', 'device-row__name', device.name);

            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'mode-target-input';
            input.placeholder = 'Desired °C';
            input.value = (20 + index).toString();

            const badgeWrap = el('div', 'mode-row__inputs');
            const badge = el('span', 'chip priority-badge', `#${index + 1}`);
            badgeWrap.appendChild(badge);

            row.append(handle, name, input, badgeWrap);
            list.appendChild(row);
          });
        }
      }

      if (tabName === 'usage') {
        const list = document.getElementById('power-list');
        const empty = document.getElementById('power-empty');
        if (list && empty) {
          empty.hidden = true;
          list.innerHTML = '';
          powerUsage.forEach((entry) => {
            const row = el('div', 'device-row');
            const hour = el('div', 'device-row__name', new Date(entry.hour).toLocaleString());
            const value = el('div', 'device-row__target', `${entry.kWh} kWh`);
            row.append(hour, value);
            list.appendChild(row);
          });
        }
      }

      if (tabName === 'price') {
        const list = document.getElementById('price-list');
        const empty = document.getElementById('price-empty');
        if (list && empty) {
          empty.hidden = true;
          list.innerHTML = '';
          prices.slice(0, 8).forEach((entry) => {
            const row = el('div', 'device-row');
            const hour = el('div', 'device-row__name', new Date(entry.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
            const value = el('div', 'device-row__target', `${Math.round(entry.total)} øre/kWh`);
            if (entry.isCheap) row.classList.add('cheap');
            if (entry.isExpensive) row.classList.add('expensive');
            row.append(hour, value);
            list.appendChild(row);
          });
        }
      }
    }, tab, mockDevices, mockPlan, mockPowerUsage, mockPrices);

    await page.screenshot({
      path: path.join(__dirname, `${tab}-${browserName}.png`),
      fullPage: true,
    });
  }

  await context.close();
} finally {
  await browser.close();
}
