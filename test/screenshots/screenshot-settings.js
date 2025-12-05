const puppeteer = require('puppeteer');
const path = require('path');

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
    budgetKWh: 5.0
  },
  devices: [
    { id: 'dev-1', name: 'Living Room Heater', priority: 1, currentTemperature: 21.5, currentTarget: 22, plannedTarget: 22, currentState: 'heating', plannedState: 'keep', reason: 'Temperature stable' },
    { id: 'dev-2', name: 'Kitchen Radiator', priority: 2, currentTemperature: 20.8, currentTarget: 21, plannedTarget: 21, currentState: 'heating', plannedState: 'keep', reason: 'Below target' },
    { id: 'dev-3', name: 'Bedroom Heater', priority: 3, currentTemperature: 19.2, currentTarget: 20, plannedTarget: 18, currentState: 'heating', plannedState: 'shed', reason: 'Capacity limit reached' },
    { id: 'dev-4', name: 'Bathroom Floor Heat', priority: 4, currentTemperature: 23.1, currentTarget: 24, plannedTarget: 22, currentState: 'idle', plannedState: 'shed', reason: 'Price optimization' },
    { id: 'dev-5', name: 'Office Heater', priority: 5, currentTemperature: 18.5, currentTarget: 20, plannedTarget: 18, currentState: 'heating', plannedState: 'shed', reason: 'Low priority device' },
    { id: 'dev-6', name: 'Guest Room Radiator', priority: 6, currentTemperature: 17.0, currentTarget: 18, plannedTarget: 16, currentState: 'idle', plannedState: 'shed', reason: 'Room unoccupied' },
  ]
};

// Mock power usage data
const mockPowerUsage = [];
const now = new Date();
for (let i = 5; i >= 0; i--) {
  const hour = new Date(now);
  hour.setHours(hour.getHours() - i, 0, 0, 0);
  mockPowerUsage.push({
    hour: hour.toISOString(),
    kWh: (Math.random() * 2 + 1).toFixed(3)
  });
}

// Mock price data
const mockPrices = [];
for (let i = 0; i < 24; i++) {
  const hour = new Date(now);
  hour.setHours(hour.getHours() + i, 0, 0, 0);
  const basePrice = 50 + Math.random() * 100;
  mockPrices.push({
    startsAt: hour.toISOString(),
    total: basePrice,
    isCheap: basePrice < 70,
    isExpensive: basePrice > 120
  });
}

const tabs = ['devices', 'modes', 'power', 'plan', 'price'];

// Get browser from command line args: node screenshot-settings.js [firefox]
const useFirefox = process.argv.includes('firefox');

(async () => {
  const browser = await puppeteer.launch({ 
    headless: true,
    product: useFirefox ? 'firefox' : 'chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const browserName = useFirefox ? 'firefox' : 'chrome';
  
  const page = await browser.newPage();
  await page.setViewport({ width: 480, height: 900 });
  
  const htmlPath = `file://${path.join(__dirname, 'settings', 'index.html')}`;
  
  for (const tab of tabs) {
    await page.goto(htmlPath, { waitUntil: 'domcontentloaded' });
    
    // Inject mock data and render based on the tab
    await page.evaluate((tabName, devices, plan, powerUsage, prices) => {
      // Hide ALL panels first
      document.querySelectorAll('.panel').forEach(el => {
        el.classList.add('hidden');
      });
      
      // Show only the target panel
      const panel = document.getElementById(`${tabName}-panel`);
      if (panel) {
        panel.classList.remove('hidden');
      }
      
      // Update active tab styling
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.tab === tabName) {
          btn.classList.add('active');
        }
      });

      // Helper to create elements
      const el = (tag, className, text) => {
        const e = document.createElement(tag);
        if (className) e.className = className;
        if (text) e.textContent = text;
        return e;
      };

      // Render devices tab
      if (tabName === 'devices') {
        const list = document.getElementById('device-list');
        const empty = document.getElementById('empty-state');
        if (list && empty) {
          empty.hidden = true;
          list.innerHTML = '';
          devices.forEach(device => {
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

      // Render plan tab
      if (tabName === 'plan') {
        const list = document.getElementById('plan-list');
        const empty = document.getElementById('plan-empty');
        const meta = document.getElementById('plan-meta');
        if (list && empty && meta) {
          empty.hidden = true;
          const m = plan.meta;
          meta.innerHTML = `<div>Now ${m.totalKw.toFixed(1)}kW / Limit ${m.softLimitKw.toFixed(1)}kW</div><div>${m.headroomKw.toFixed(1)}kW available · This hour: ${m.usedKWh.toFixed(2)} of ${m.budgetKWh.toFixed(1)}kWh</div>`;
          list.innerHTML = '';
          plan.devices.forEach(dev => {
            const row = el('div', 'device-row');
            const metaWrap = el('div', 'device-row__target plan-row__meta');
            const name = el('div', 'device-row__name', dev.name);
            
            const tempLine = el('div', 'plan-meta-line');
            const targetChanging = dev.plannedTarget !== dev.currentTarget;
            const targetText = targetChanging ? `${dev.currentTarget}° → ${dev.plannedTarget}°` : `${dev.currentTarget}°`;
            tempLine.innerHTML = `<span class="plan-label">Temperature</span><span>${dev.currentTemperature.toFixed(1)}° / target ${targetText}</span>`;
            
            const powerLine = el('div', 'plan-meta-line');
            const plannedPower = dev.plannedState === 'shed' ? 'off' : dev.currentState;
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

      // Render modes tab
      if (tabName === 'modes') {
        const list = document.getElementById('priority-list');
        const empty = document.getElementById('priority-empty');
        if (list && empty) {
          empty.hidden = true;
          list.innerHTML = '';
          devices.forEach((device, i) => {
            const row = el('div', 'device-row draggable mode-row');
            row.draggable = true;
            
            const handle = el('span', 'drag-handle', '↕');
            const name = el('div', 'device-row__name', device.name);
            
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'mode-target-input';
            input.placeholder = 'Desired °C';
            input.value = (20 + i).toString();
            
            const badgeWrap = el('div', 'mode-row__inputs');
            const badge = el('span', 'chip priority-badge', `#${i + 1}`);
            badgeWrap.appendChild(badge);
            
            row.append(handle, name, input, badgeWrap);
            list.appendChild(row);
          });
        }
      }

      // Render power tab
      if (tabName === 'power') {
        const list = document.getElementById('power-list');
        const empty = document.getElementById('power-empty');
        if (list && empty) {
          empty.hidden = true;
          list.innerHTML = '';
          powerUsage.forEach(entry => {
            const row = el('div', 'device-row');
            const hour = el('div', 'device-row__name', new Date(entry.hour).toLocaleString());
            const val = el('div', 'device-row__target');
            val.innerHTML = `<span class="chip"><strong>Energy</strong><span>${entry.kWh} kWh</span></span>`;
            row.append(hour, val);
            list.appendChild(row);
          });
        }
      }

      // Render price tab
      if (tabName === 'price') {
        const list = document.getElementById('price-list');
        const empty = document.getElementById('price-empty');
        const badge = document.getElementById('price-status-badge');
        if (list && empty) {
          empty.hidden = true;
          list.innerHTML = '';
          
          if (badge) {
            badge.textContent = 'Now: 85.2 øre/kWh';
            badge.classList.add('ok');
          }
          
          const cheapPrices = prices.filter(p => p.isCheap);
          const expensivePrices = prices.filter(p => p.isExpensive);
          
          if (cheapPrices.length > 0) {
            const header = el('div', 'muted', '🟢 Cheap hours (< 70 øre)');
            header.style.cssText = 'padding: 8px 0; margin-top: 12px; font-size: 13px; font-weight: 600; border-bottom: 1px solid var(--panel-border); color: var(--color-base-accent-default);';
            list.appendChild(header);
            cheapPrices.slice(0, 3).forEach(p => {
              const row = el('div', 'device-row price-row');
              const time = el('div', 'device-row__name', new Date(p.startsAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}));
              const priceWrap = el('div', 'device-row__target');
              const chip = el('span', 'chip price-low');
              chip.innerHTML = `<strong>${p.total.toFixed(1)}</strong><span>øre/kWh</span>`;
              priceWrap.appendChild(chip);
              row.append(time, priceWrap);
              list.appendChild(row);
            });
          }
          
          if (expensivePrices.length > 0) {
            const header = el('div', 'muted', '🔴 Expensive hours (> 120 øre)');
            header.style.cssText = 'padding: 8px 0; margin-top: 12px; font-size: 13px; font-weight: 600; border-bottom: 1px solid var(--panel-border); color: var(--color-state-negative-text);';
            list.appendChild(header);
            expensivePrices.slice(0, 3).forEach(p => {
              const row = el('div', 'device-row price-row');
              const time = el('div', 'device-row__name', new Date(p.startsAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}));
              const priceWrap = el('div', 'device-row__target');
              const chip = el('span', 'chip price-high');
              chip.innerHTML = `<strong>${p.total.toFixed(1)}</strong><span>øre/kWh</span>`;
              priceWrap.appendChild(chip);
              row.append(time, priceWrap);
              list.appendChild(row);
            });
          }
        }
      }

    }, tab, mockDevices, mockPlan, mockPowerUsage, mockPrices);
    
    // Wait a bit for any CSS transitions
    await new Promise(resolve => setTimeout(resolve, 300));
    
    const filename = `screenshot-${browserName}-${tab}.png`;
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Saved: ${filename}`);
  }
  
  await browser.close();
  console.log('Done! All screenshots saved.');
})();
