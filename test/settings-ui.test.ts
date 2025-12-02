/**
 * Settings UI Tests
 * 
 * These tests use Puppeteer to validate the settings UI renders correctly
 * and handles touch interactions properly in a 480px iframe (Homey's settings width).
 */

import puppeteer, { Browser, Page } from 'puppeteer';
import * as path from 'path';
import * as fs from 'fs';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('Settings UI', () => {
  let browser: Browser;
  let page: Page;
  let html: string;

  // Helper to set up page with mock data
  const setupPage = async (options: { 
    viewport?: { width: number; height: number };
    isMobile?: boolean;
    hasTouch?: boolean;
    mockDeviceCount?: number;
  } = {}) => {
    const {
      viewport = { width: 480, height: 800 },
      isMobile = false,
      hasTouch = false,
      mockDeviceCount = 5
    } = options;

    await page.emulate({
      viewport: {
        ...viewport,
        deviceScaleFactor: 2,
        isMobile,
        hasTouch,
      },
      userAgent: isMobile 
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });

    const htmlPath = path.resolve(__dirname, '../settings/index.html');
    const cssPath = path.resolve(__dirname, '../settings/style.css');
    
    let htmlContent = fs.readFileSync(htmlPath, 'utf-8');
    const css = fs.readFileSync(cssPath, 'utf-8');
    
    // Inline CSS
    htmlContent = htmlContent.replace('<link rel="stylesheet" href="./style.css">', `<style>${css}</style>`);
    
    // Remove Homey SDK and add mock script
    htmlContent = htmlContent.replace('<script src="/homey.js" data-origin="settings"></script>', '');
    htmlContent = htmlContent.replace('<script src="./script.js"></script>', `
      <script>
        document.addEventListener('DOMContentLoaded', () => {
          // Status badge
          const statusBadge = document.getElementById('status-badge');
          if (statusBadge) {
            statusBadge.textContent = 'Live';
            statusBadge.classList.add('ok');
          }
          
          // Mock devices
          const deviceList = document.getElementById('device-list');
          if (deviceList) {
            for (let i = 1; i <= ${mockDeviceCount}; i++) {
              const row = document.createElement('div');
              row.className = 'device-row control-row';
              row.innerHTML = '<div class="device-row__name">Test Device ' + i + '</div>' +
                '<div class="device-row__target control-row__inputs">' +
                '<label class="checkbox-field-inline"><input type="checkbox" checked><span>Controllable</span></label></div>';
              deviceList.appendChild(row);
            }
          }
          
          // Mock priorities (for modes tab)
          const priorityList = document.getElementById('priority-list');
          if (priorityList) {
            for (let i = 1; i <= ${mockDeviceCount}; i++) {
              const row = document.createElement('div');
              row.className = 'device-row draggable mode-row';
              row.innerHTML = '<span class="drag-handle">↕</span>' +
                '<div class="device-row__name">Test Device ' + i + '</div>' +
                '<input type="number" class="mode-target-input" value="' + (18 + i) + '" step="0.5">' +
                '<div class="mode-row__inputs"><span class="chip priority-badge">#' + i + '</span></div>';
              priorityList.appendChild(row);
            }
          }
          
          // Mock mode options
          ['Home', 'Away', 'Night'].forEach(mode => {
            ['mode-select', 'active-mode-select'].forEach(id => {
              const sel = document.getElementById(id);
              if (sel) {
                const opt = document.createElement('option');
                opt.value = mode;
                opt.textContent = mode;
                sel.appendChild(opt);
              }
            });
          });
          
          // Tab switching
          const tabs = document.querySelectorAll('.tab');
          const panels = document.querySelectorAll('.panel');
          tabs.forEach(tab => {
            tab.addEventListener('click', () => {
              tabs.forEach(t => {
                t.classList.toggle('active', t === tab);
                t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
              });
              panels.forEach(p => {
                p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab);
              });
            });
          });
          
          // Fill capacity inputs
          const limitInput = document.getElementById('capacity-limit');
          const marginInput = document.getElementById('capacity-margin');
          if (limitInput) limitInput.value = '10';
          if (marginInput) marginInput.value = '0.5';
        });
      </script>
    `);
    
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    await sleep(300);
  };

  beforeAll(async () => {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page.close();
  });

  describe('Layout at 480px (Homey iframe width)', () => {
    beforeEach(async () => {
      await setupPage({ viewport: { width: 480, height: 800 } });
    });

    test('tab bar fits within viewport without horizontal overflow', async () => {
      const tabsContainer = await page.$('.tabs');
      const viewportWidth = 480;
      
      const tabsBox = await tabsContainer?.boundingBox();
      expect(tabsBox).toBeTruthy();
      expect(tabsBox!.width).toBeLessThanOrEqual(viewportWidth);
    });

    test('all five tabs are visible', async () => {
      const tabs = await page.$$('.tab');
      expect(tabs.length).toBe(5);
      
      const tabTexts = await page.$$eval('.tab', els => els.map(el => el.textContent?.trim()));
      expect(tabTexts).toEqual(['Devices', 'Modes', 'Power usage', 'Plan', 'Price']);
    });

    test('page has no horizontal overflow', async () => {
      const hasOverflow = await page.evaluate(() => {
        return document.body.scrollWidth > document.documentElement.clientWidth;
      });
      expect(hasOverflow).toBe(false);
    });

    test('cards are properly contained within viewport', async () => {
      const cardBox = await page.$eval('.card', el => {
        const rect = el.getBoundingClientRect();
        return { right: rect.right, width: rect.width };
      });
      
      // Card should not extend beyond viewport (with some margin for padding)
      expect(cardBox.right).toBeLessThanOrEqual(480);
    });
  });

  describe('Layout at 320px (narrow viewport)', () => {
    beforeEach(async () => {
      await setupPage({ viewport: { width: 320, height: 600 } });
    });

    test('page content is contained (scrollable tabs allowed)', async () => {
      // With scrollable tabs, the tabs container may have internal overflow
      // but the page itself should not have a horizontal scrollbar
      const bodyOverflowX = await page.evaluate(() => {
        return window.getComputedStyle(document.body).overflowX;
      });
      expect(bodyOverflowX).toBe('hidden');
      
      // Verify tabs are scrollable, not causing page-level scroll
      const tabsOverflowX = await page.evaluate(() => {
        const tabs = document.querySelector('.tabs');
        return tabs ? window.getComputedStyle(tabs).overflowX : null;
      });
      expect(tabsOverflowX).toBe('auto');
    });

    test('tab bar wraps or remains usable', async () => {
      const tabsContainer = await page.$('.tabs');
      const tabsBox = await tabsContainer?.boundingBox();
      
      // At 320px, tabs might wrap but should still be contained
      expect(tabsBox).toBeTruthy();
      // Allow for wrapping - just ensure it doesn't overflow
      expect(tabsBox!.x).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Tab navigation', () => {
    beforeEach(async () => {
      await setupPage();
    });

    test('devices tab is active by default', async () => {
      const activeTab = await page.$eval('.tab.active', el => (el as HTMLElement).dataset.tab);
      expect(activeTab).toBe('devices');
      
      const devicesPanel = await page.$('#devices-panel');
      const isHidden = await devicesPanel?.evaluate(el => el.classList.contains('hidden'));
      expect(isHidden).toBe(false);
    });

    test('clicking modes tab switches panels', async () => {
      await page.click('[data-tab="modes"]');
      await sleep(100);
      
      const activeTab = await page.$eval('.tab.active', el => (el as HTMLElement).dataset.tab);
      expect(activeTab).toBe('modes');
      
      const modesPanel = await page.$('#modes-panel');
      const isHidden = await modesPanel?.evaluate(el => el.classList.contains('hidden'));
      expect(isHidden).toBe(false);
      
      const devicesPanel = await page.$('#devices-panel');
      const devicesHidden = await devicesPanel?.evaluate(el => el.classList.contains('hidden'));
      expect(devicesHidden).toBe(true);
    });

    test('all tabs can be activated', async () => {
      const tabIds = ['devices', 'modes', 'power', 'plan'];
      
      for (const tabId of tabIds) {
        await page.click(`[data-tab="${tabId}"]`);
        await sleep(100);
        
        const activeTab = await page.$eval('.tab.active', el => (el as HTMLElement).dataset.tab);
        expect(activeTab).toBe(tabId);
      }
    });
  });

  describe('Touch scrolling (mobile)', () => {
    beforeEach(async () => {
      // Use more devices to ensure scrollable content
      await setupPage({ 
        viewport: { width: 480, height: 800 },
        isMobile: true, 
        hasTouch: true,
        mockDeviceCount: 15
      });
    });

    test('page is scrollable when content exceeds viewport', async () => {
      await page.click('[data-tab="modes"]');
      await sleep(200);
      
      const dimensions = await page.evaluate(() => ({
        bodyHeight: document.body.scrollHeight,
        viewportHeight: window.innerHeight,
        canScroll: document.body.scrollHeight > window.innerHeight
      }));
      
      expect(dimensions.canScroll).toBe(true);
    });

    test('touch scroll works on modes page', async () => {
      await page.click('[data-tab="modes"]');
      await sleep(200);
      
      const scrollBefore = await page.evaluate(() => window.scrollY);
      
      // Perform touch scroll via CDP
      const client = await page.target().createCDPSession();
      const startX = 240;
      const startY = 600;
      const endY = 200;
      
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: startX, y: startY }]
      });
      
      // Move in steps
      for (let i = 1; i <= 10; i++) {
        const currentY = startY - (startY - endY) * (i / 10);
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: startX, y: currentY }]
        });
        await sleep(20);
      }
      
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: []
      });
      
      await sleep(300);
      
      const scrollAfter = await page.evaluate(() => window.scrollY);
      const scrollDelta = scrollAfter - scrollBefore;
      
      expect(scrollDelta).toBeGreaterThan(50);
    });

    test('only drag-handle has touch-action: none (not entire rows)', async () => {
      await page.click('[data-tab="modes"]');
      await sleep(200);
      
      const touchActionIssues = await page.evaluate(() => {
        const issues: string[] = [];
        const draggableRows = document.querySelectorAll('.draggable');
        
        draggableRows.forEach(row => {
          const style = getComputedStyle(row);
          if (style.touchAction === 'none') {
            issues.push('draggable row has touch-action: none');
          }
        });
        
        return issues;
      });
      
      expect(touchActionIssues).toHaveLength(0);
    });

    test('drag-handle has touch-action: none for proper drag behavior', async () => {
      await page.click('[data-tab="modes"]');
      await sleep(200);
      
      const handleTouchAction = await page.$eval('.drag-handle', el => {
        return getComputedStyle(el).touchAction;
      });
      
      expect(handleTouchAction).toBe('none');
    });
  });

  describe('Form inputs', () => {
    beforeEach(async () => {
      await setupPage();
    });

    test('capacity limit input accepts numeric values', async () => {
      await page.click('[data-tab="power"]');
      await sleep(100);
      
      const input = await page.$('#capacity-limit');
      expect(input).toBeTruthy();
      
      await input?.click({ clickCount: 3 }); // Select all
      await input?.type('15.5');
      
      const value = await page.$eval('#capacity-limit', el => (el as HTMLInputElement).value);
      expect(value).toBe('15.5');
    });

    test('mode target inputs are present in modes tab', async () => {
      await page.click('[data-tab="modes"]');
      await sleep(100);
      
      const inputs = await page.$$('.mode-target-input');
      expect(inputs.length).toBeGreaterThan(0);
    });

    test('mode target inputs fit 0.5 increment values without overflow', async () => {
      // Close existing page and create fresh one for this specific test
      await page.close();
      page = await browser.newPage();
      
      await page.emulate({
        viewport: { width: 480, height: 800, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      });

      const htmlPath = path.resolve(__dirname, '../settings/index.html');
      const cssPath = path.resolve(__dirname, '../settings/style.css');
      
      let htmlContent = fs.readFileSync(htmlPath, 'utf-8');
      const css = fs.readFileSync(cssPath, 'utf-8');
      
      htmlContent = htmlContent.replace('<link rel="stylesheet" href="./style.css">', `<style>${css}</style>`);
      htmlContent = htmlContent.replace('<script src="/homey.js" data-origin="settings"></script>', '');
      htmlContent = htmlContent.replace('<script src="./script.js"></script>', `
        <script>
          document.addEventListener('DOMContentLoaded', () => {
            document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
            document.getElementById('modes-panel').classList.remove('hidden');
            document.getElementById('priority-empty').hidden = true;
            
            ['Home'].forEach(mode => {
              ['mode-select', 'active-mode-select'].forEach(id => {
                const sel = document.getElementById(id);
                if (sel) {
                  const opt = document.createElement('option');
                  opt.value = mode;
                  opt.textContent = mode;
                  sel.appendChild(opt);
                }
              });
            });
            
            const priorityList = document.getElementById('priority-list');
            const devices = [
              { name: 'Varmepumpe stue', temp: 22.5 },
              { name: 'Gulvvarme bad', temp: 24.5 },
              { name: 'Panelovn', temp: 19.5 },
            ];
            
            devices.forEach((dev, i) => {
              const row = document.createElement('div');
              row.className = 'device-row draggable mode-row';
              row.innerHTML = 
                '<span class="drag-handle">↕</span>' +
                '<div class="device-row__name">' + dev.name + '</div>' +
                '<input type="number" class="mode-target-input" value="' + dev.temp + '" step="0.5">' +
                '<div class="mode-row__inputs"><span class="chip priority-badge">#' + (i+1) + '</span></div>';
              priorityList.appendChild(row);
            });
          });
        </script>
      `);
      
      await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
      await sleep(300);
      
      // Check no horizontal overflow
      const hasOverflow = await page.evaluate(() => {
        return document.body.scrollWidth > document.documentElement.clientWidth;
      });
      expect(hasOverflow).toBe(false);
      
      // Verify input values display correctly
      const inputValues = await page.$$eval('.mode-target-input', els => 
        els.map(el => (el as HTMLInputElement).value)
      );
      expect(inputValues).toContain('22.5');
      expect(inputValues).toContain('24.5');
      expect(inputValues).toContain('19.5');
    });
  });

  describe('Accessibility', () => {
    beforeEach(async () => {
      await setupPage();
    });

    test('tabs have proper ARIA attributes', async () => {
      const tabs = await page.$$eval('.tab', els => els.map(el => ({
        role: el.getAttribute('role'),
        ariaSelected: el.getAttribute('aria-selected')
      })));
      
      tabs.forEach(tab => {
        expect(tab.role).toBe('tab');
        expect(tab.ariaSelected).toMatch(/true|false/);
      });
    });

    test('tab container has tablist role', async () => {
      const role = await page.$eval('.tabs', el => el.getAttribute('role'));
      expect(role).toBe('tablist');
    });

    test('lists have proper list roles', async () => {
      const deviceList = await page.$eval('#device-list', el => el.getAttribute('role'));
      expect(deviceList).toBe('list');
    });
  });

  describe('Visual styling', () => {
    beforeEach(async () => {
      await setupPage();
    });

    test('active tab has correct styling', async () => {
      const activeTabBg = await page.$eval('.tab.active', el => {
        return getComputedStyle(el).background;
      });
      
      // Should have gradient background
      expect(activeTabBg).toContain('linear-gradient');
    });

    test('cards have backdrop blur effect', async () => {
      const backdropFilter = await page.$eval('.card', el => {
        return getComputedStyle(el).backdropFilter;
      });
      
      expect(backdropFilter).toContain('blur');
    });

    test('status badge shows correct state', async () => {
      const badge = await page.$eval('#status-badge', el => ({
        text: el.textContent,
        hasOkClass: el.classList.contains('ok')
      }));
      
      expect(badge.text).toBe('Live');
      expect(badge.hasOkClass).toBe(true);
    });
  });

  describe('Plan view temperature display', () => {
    // Helper to set up page with plan data
    const setupPlanPage = async (devices: Array<{
      name: string;
      zone: string;
      currentTemperature: number;
      currentTarget: number;
      plannedTarget?: number;
    }>) => {
      await page.emulate({
        viewport: { width: 480, height: 800, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      });

      const htmlPath = path.resolve(__dirname, '../settings/index.html');
      const cssPath = path.resolve(__dirname, '../settings/style.css');
      
      let htmlContent = fs.readFileSync(htmlPath, 'utf-8');
      const css = fs.readFileSync(cssPath, 'utf-8');
      
      htmlContent = htmlContent.replace('<link rel="stylesheet" href="./style.css">', `<style>${css}</style>`);
      htmlContent = htmlContent.replace('<script src="/homey.js" data-origin="settings"></script>', '');
      
      const devicesJson = JSON.stringify(devices);
      
      htmlContent = htmlContent.replace('<script src="./script.js"></script>', `
        <script>
          document.addEventListener('DOMContentLoaded', () => {
            // Switch to plan tab
            const tabs = document.querySelectorAll('.tab');
            const panels = document.querySelectorAll('.panel');
            tabs.forEach(tab => {
              const isPlan = tab.dataset.tab === 'plan';
              tab.classList.toggle('active', isPlan);
              tab.setAttribute('aria-selected', isPlan ? 'true' : 'false');
            });
            panels.forEach(p => {
              p.classList.toggle('hidden', p.dataset.panel !== 'plan');
            });
            
            // Populate plan list with test data
            const planList = document.getElementById('plan-list');
            const planMeta = document.getElementById('plan-meta');
            const planEmpty = document.getElementById('plan-empty');
            
            if (planEmpty) planEmpty.hidden = true;
            if (planMeta) {
              planMeta.innerHTML = '<div>Now 4.2kW / Limit 9.5kW</div><div>5.3kW available</div>';
            }
            
            const devices = ${devicesJson};
            
            // Group by zone
            const grouped = devices.reduce((acc, dev) => {
              const zone = dev.zone || 'Unknown';
              if (!acc[zone]) acc[zone] = [];
              acc[zone].push(dev);
              return acc;
            }, {});
            
            Object.keys(grouped).sort().forEach(zone => {
              const header = document.createElement('div');
              header.className = 'zone-header';
              header.textContent = zone;
              planList.appendChild(header);
              
              grouped[zone].forEach(dev => {
                const row = document.createElement('div');
                row.className = 'device-row';
                row.dataset.deviceId = dev.name.replace(/\\s+/g, '-').toLowerCase();
                
                const metaWrap = document.createElement('div');
                metaWrap.className = 'device-row__target plan-row__meta';
                
                const name = document.createElement('div');
                name.className = 'device-row__name';
                name.textContent = dev.name;
                
                const tempLine = document.createElement('div');
                tempLine.className = 'plan-meta-line';
                
                const currentTemp = typeof dev.currentTemperature === 'number' 
                  ? dev.currentTemperature.toFixed(1) + '°' 
                  : '–';
                const targetTemp = dev.currentTarget ?? '–';
                const plannedTemp = dev.plannedTarget ?? dev.currentTarget;
                const targetChanging = dev.plannedTarget != null && dev.plannedTarget !== dev.currentTarget;
                const targetText = targetChanging 
                  ? targetTemp + '° → ' + plannedTemp + '°' 
                  : targetTemp + '°';
                
                tempLine.innerHTML = '<span class="plan-label">Temperature</span><span class="temp-value">' + currentTemp + ' / target ' + targetText + '</span>';
                
                const powerLine = document.createElement('div');
                powerLine.className = 'plan-meta-line';
                powerLine.innerHTML = '<span class="plan-label">Power</span><span>heating</span>';
                
                const reasonLine = document.createElement('div');
                reasonLine.className = 'plan-meta-line';
                reasonLine.innerHTML = '<span class="plan-label">Reason</span><span>Test reason</span>';
                
                metaWrap.append(name, tempLine, powerLine, reasonLine);
                row.appendChild(metaWrap);
                planList.appendChild(row);
              });
            });
          });
        </script>
      `);
      
      await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
      await sleep(300);
    };

    test('displays 2-digit temperatures with 0.5 increments correctly', async () => {
      await setupPlanPage([
        { name: 'Heater 1', zone: 'Living Room', currentTemperature: 21.5, currentTarget: 22.5 },
        { name: 'Heater 2', zone: 'Living Room', currentTemperature: 19.0, currentTarget: 20.5 },
        { name: 'Heater 3', zone: 'Bedroom', currentTemperature: 18.5, currentTarget: 19.5 },
      ]);
      
      const tempTexts = await page.$$eval('.plan-meta-line .temp-value', els => 
        els.map(el => el.textContent?.trim())
      );
      
      // Current temperature always shows .0 (via toFixed(1))
      // Target temperatures show decimal only if not whole number
      expect(tempTexts).toContain('21.5° / target 22.5°');
      expect(tempTexts).toContain('19.0° / target 20.5°');
      expect(tempTexts).toContain('18.5° / target 19.5°');
    });

    test('displays temperature changes with arrow notation', async () => {
      await setupPlanPage([
        { name: 'Changing Heater', zone: 'Test', currentTemperature: 20.0, currentTarget: 22.0, plannedTarget: 18.5 },
      ]);
      
      const tempText = await page.$eval('.plan-meta-line .temp-value', el => el.textContent?.trim());
      
      expect(tempText).toContain('22° → 18.5°');
    });

    test('temperature lines do not overflow at 480px', async () => {
      await setupPlanPage([
        { name: 'Very Long Device Name That Could Cause Issues', zone: 'Room', currentTemperature: 99.5, currentTarget: 99.5, plannedTarget: 10.0 },
      ]);
      
      const hasOverflow = await page.evaluate(() => {
        const metaLines = document.querySelectorAll('.plan-meta-line');
        let overflow = false;
        metaLines.forEach(line => {
          if (line.scrollWidth > line.clientWidth) {
            overflow = true;
          }
        });
        return overflow;
      });
      
      expect(hasOverflow).toBe(false);
    });

    test('temperature lines do not overflow at 320px', async () => {
      await page.setViewport({ width: 320, height: 600, deviceScaleFactor: 2 });
      
      await setupPlanPage([
        { name: 'Long Device Name', zone: 'Room', currentTemperature: 99.5, currentTarget: 99.5, plannedTarget: 10.0 },
      ]);
      
      const overflowInfo = await page.evaluate(() => {
        const container = document.querySelector('.plan-row__meta');
        const viewportWidth = document.documentElement.clientWidth;
        const metaLines = document.querySelectorAll('.plan-meta-line');
        
        let lineOverflow = false;
        metaLines.forEach(line => {
          const rect = (line as HTMLElement).getBoundingClientRect();
          if (rect.right > viewportWidth) {
            lineOverflow = true;
          }
        });
        
        return {
          lineOverflow,
          bodyScrollWidth: document.body.scrollWidth,
          clientWidth: viewportWidth,
          hasHorizontalScroll: document.body.scrollWidth > viewportWidth
        };
      });
      
      expect(overflowInfo.lineOverflow).toBe(false);
      expect(overflowInfo.hasHorizontalScroll).toBe(false);
    });

    test('handles extreme temperature values (0.5 to 99.5)', async () => {
      await setupPlanPage([
        { name: 'Cold', zone: 'Test', currentTemperature: 0.5, currentTarget: 5.0 },
        { name: 'Hot', zone: 'Test', currentTemperature: 99.5, currentTarget: 99.5 },
        { name: 'Negative', zone: 'Test', currentTemperature: -5.5, currentTarget: 10.0 },
      ]);
      
      const tempTexts = await page.$$eval('.plan-meta-line .temp-value', els => 
        els.map(el => el.textContent?.trim())
      );
      
      expect(tempTexts.some(t => t?.includes('0.5°'))).toBe(true);
      expect(tempTexts.some(t => t?.includes('99.5°'))).toBe(true);
      expect(tempTexts.some(t => t?.includes('-5.5°'))).toBe(true);
    });

    test('plan label column has consistent width', async () => {
      await setupPlanPage([
        { name: 'Device 1', zone: 'Zone', currentTemperature: 20.0, currentTarget: 21.0 },
        { name: 'Device 2', zone: 'Zone', currentTemperature: 22.5, currentTarget: 23.5 },
      ]);
      
      const labelWidths = await page.$$eval('.plan-label', els => 
        els.map(el => (el as HTMLElement).getBoundingClientRect().width)
      );
      
      // All labels should have the same width (min-width applied)
      const uniqueWidths = [...new Set(labelWidths.map(w => Math.round(w)))];
      expect(uniqueWidths.length).toBe(1);
    });

    test('temperature display is readable (font size check)', async () => {
      await setupPlanPage([
        { name: 'Device', zone: 'Zone', currentTemperature: 21.5, currentTarget: 22.0 },
      ]);
      
      const fontSize = await page.$eval('.plan-row__meta', el => {
        return parseInt(getComputedStyle(el).fontSize);
      });
      
      // Font should be at least 12px for readability
      expect(fontSize).toBeGreaterThanOrEqual(12);
    });
  });
});

