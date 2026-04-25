/**
 * Settings UI Tests
 *
 * These tests use Playwright's browser API to validate the settings UI renders correctly
 * and handles touch interactions properly in a 480px iframe (Homey's settings width).
 *
 * Optimized for speed: reuses browser page between tests, caches file reads,
 * and uses domcontentloaded instead of networkidle0.
 */

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Cache file contents at module level - read once
const htmlPath = path.resolve(__dirname, '../dist/index.html');
const cssPath = path.resolve(__dirname, '../dist/style.css');
const tokensCssPath = path.resolve(__dirname, '../dist/tokens.css');
const baseHtml = fs.readFileSync(htmlPath, 'utf-8');
let baseCss = fs.readFileSync(cssPath, 'utf-8');

// Inline the tokens.css import (file:// protocol doesn't support @import)
if (fs.existsSync(tokensCssPath)) {
  const tokensCss = fs.readFileSync(tokensCssPath, 'utf-8');
  baseCss = baseCss.replace("@import url('tokens.css');", tokensCss);
}

describe('Settings UI', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  // Prepare HTML with inlined CSS (cached)
  const prepareHtml = (mockScript: string): string => {
    const html = baseHtml
      .replace('<link rel="stylesheet" href="./style.css">', `<style>${baseCss}</style>`)
      .replace('<script src="/homey.js" data-origin="settings"></script>', '')
      .replace('<script src="./script.js"></script>', `<script>${mockScript}</script>`);
    return html;
  };

  // Default mock script for standard page setup
  const getDefaultMockScript = (mockDeviceCount: number = 5): string => `
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
      
      // Mock price optimization list
      const priceOptList = document.getElementById('price-optimization-list');
      if (priceOptList) {
        for (let i = 1; i <= 3; i++) {
          const row = document.createElement('div');
          row.className = 'device-row price-optimization-row';
          row.setAttribute('role', 'listitem');
          
          const nameWrap = document.createElement('div');
          nameWrap.className = 'device-row__name';
          nameWrap.textContent = 'Water Heater ' + i;
          
          const normalInput = document.createElement('input');
          normalInput.type = 'number';
          normalInput.className = 'price-opt-input';
          normalInput.value = '55';
          
          const boostInput = document.createElement('input');
          boostInput.type = 'number';
          boostInput.className = 'price-opt-input';
          boostInput.value = '75';
          
          const hoursInput = document.createElement('input');
          hoursInput.type = 'number';
          hoursInput.className = 'price-opt-input price-opt-hours';
          hoursInput.value = '4';
          
          row.append(nameWrap, normalInput, boostInput, hoursInput);
          priceOptList.appendChild(row);
        }
      }

      // Overshoot control toggle
      const overshootSelect = document.getElementById('device-detail-overshoot');
      const overshootRow = document.getElementById('device-detail-overshoot-temp-row');
      const overshootInput = document.getElementById('device-detail-overshoot-temp');
      const updateOvershoot = () => {
        if (!overshootRow || !overshootSelect) return;
        const isTemp = overshootSelect.value === 'set_temperature';
        overshootRow.hidden = !isTemp;
        if (overshootInput) overshootInput.disabled = !isTemp;
      };
      if (overshootSelect) {
        overshootSelect.addEventListener('change', updateOvershoot);
      }
      updateOvershoot();
    });
  `;

  const recreatePage = async (options: {
    viewport: { width: number; height: number };
    isMobile: boolean;
    hasTouch: boolean;
  }): Promise<void> => {
    const {
      viewport,
      isMobile,
      hasTouch,
    } = options;
    if (page) await page.close();
    if (context) await context.close();
    context = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
      isMobile,
      hasTouch,
      userAgent: isMobile
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    page = await context.newPage();
  };

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
      mockDeviceCount = 5,
    } = options;
    await recreatePage({
      viewport,
      isMobile,
      hasTouch,
    });

    const html = prepareHtml(getDefaultMockScript(mockDeviceCount));
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await sleep(50); // Minimal wait for DOM to settle
  };

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  });

  afterAll(async () => {
    if (page) await page.close();
    if (context) await context.close();
    await browser.close();
  });

  describe('Layout at 480px (Homey iframe width)', () => {
    beforeAll(async () => {
      await setupPage({ viewport: { width: 480, height: 800 } });
    });

    test('tab bar fits within viewport without horizontal overflow', async () => {
      const tabsContainer = await page.$('.tabs');
      const tabsBox = await tabsContainer?.boundingBox();
      expect(tabsBox).toBeTruthy();
      expect(tabsBox!.width).toBeLessThanOrEqual(480);
    });

    test('main tabs are visible (two-row layout on smaller screens)', async () => {
      const mainTabs = await page.$$('.tabs > .tab');
      expect(mainTabs.length).toBeGreaterThanOrEqual(7);

      const tabTexts = await page.$$eval('.tabs > .tab', (els) => {
        const texts: string[] = [];
        for (const el of els) {
          const text = el.textContent?.trim();
          if (text) texts.push(text);
        }
        return texts;
      });
      expect(tabTexts).toContain('Devices');
      expect(tabTexts).toContain('Modes');
      expect(tabTexts).toContain('Overview');
      expect(tabTexts).toContain('Budget');
      expect(tabTexts).toContain('Usage');
      expect(tabTexts).toContain('Price');
      expect(tabTexts).toContain('Advanced');
    });

    test('page has no significant horizontal overflow', async () => {
      const overflow = await page.evaluate(() => {
        return document.body.scrollWidth - document.documentElement.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(15);
    });

    test('cards are properly contained within viewport', async () => {
      const cardBox = await page.$eval('.card', (el) => {
        const rect = el.getBoundingClientRect();
        return { right: rect.right, width: rect.width };
      });
      expect(cardBox.right).toBeLessThanOrEqual(480);
    });

    test('section hints remain visible at 480px', async () => {
      await page.click('[data-tab="budget"]');
      await sleep(50);
      const hintDisplay = await page.$eval('#budget-panel .section-hint', (el) => (
        getComputedStyle(el).display
      ));
      expect(hintDisplay).not.toBe('none');
    });
  });

  describe('Layout at 320px (narrow viewport)', () => {
    beforeAll(async () => {
      await setupPage({ viewport: { width: 320, height: 600 } });
    });

    test('page content is contained (tabs wrap without overflow)', async () => {
      const overflow = await page.evaluate(() => {
        return document.body.scrollWidth - document.documentElement.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(10);
    });

    test('tab bar wraps to multiple rows without horizontal overflow', async () => {
      const tabsContainer = await page.$('.tabs');
      const tabsBox = await tabsContainer?.boundingBox();
      expect(tabsBox).toBeTruthy();
      expect(tabsBox!.x).toBeGreaterThanOrEqual(0);
      // Tabs wrap to multiple rows — verify no horizontal scrollbar
      const overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(10);
    });

    test('section hints remain visible at 320px', async () => {
      await page.click('[data-tab="budget"]');
      await sleep(50);
      const hintDisplay = await page.$eval('#budget-panel .section-hint', (el) => (
        getComputedStyle(el).display
      ));
      expect(hintDisplay).not.toBe('none');
    });
  });

  describe('Tab navigation', () => {
    beforeAll(async () => {
      await setupPage();
    });

    test('overview tab is active by default', async () => {
      const activeTab = await page.$eval('.tab.active', (el) => (el as HTMLElement).dataset.tab);
      expect(activeTab).toBe('overview');

      const overviewPanel = await page.$('#overview-panel');
      const isHidden = await overviewPanel?.evaluate((el) => el.classList.contains('hidden'));
      expect(isHidden).toBe(false);
    });

    test('clicking modes tab switches panels', async () => {
      await page.click('[data-tab="modes"]');
      await sleep(50);

      const activeTab = await page.$eval('.tab.active', (el) => (el as HTMLElement).dataset.tab);
      expect(activeTab).toBe('modes');

      const modesPanel = await page.$('#modes-panel');
      const isHidden = await modesPanel?.evaluate((el) => el.classList.contains('hidden'));
      expect(isHidden).toBe(false);

      const devicesPanel = await page.$('#devices-panel');
      const devicesHidden = await devicesPanel?.evaluate((el) => el.classList.contains('hidden'));
      expect(devicesHidden).toBe(true);
    });

    test('main tabs can be activated', async () => {
      const mainTabIds = ['overview', 'devices', 'modes', 'budget'];

      for (const tabId of mainTabIds) {
        await page.click(`[data-tab="${tabId}"]`);
        await sleep(30);

        const activeTab = await page.$eval('.tab.active', (el) => (el as HTMLElement).dataset.tab);
        expect(activeTab).toBe(tabId);
      }
    });
  });

  describe('Touch scrolling (mobile)', () => {
    beforeAll(async () => {
      await setupPage({
        viewport: { width: 480, height: 800 },
        isMobile: true,
        hasTouch: true,
        mockDeviceCount: 15,
      });
    });

    test('page is scrollable when content exceeds viewport', async () => {
      await page.click('[data-tab="modes"]');
      await sleep(50);

      const dimensions = await page.evaluate(() => ({
        bodyHeight: document.body.scrollHeight,
        viewportHeight: window.innerHeight,
        canScroll: document.body.scrollHeight > window.innerHeight,
      }));

      expect(dimensions.canScroll).toBe(true);
    });

    test('touch scroll works on modes page', async () => {
      await page.click('[data-tab="modes"]');
      await sleep(50);

      const scrollBefore = await page.evaluate(() => window.scrollY);

      const client = await context.newCDPSession(page);
      const startX = 240;
      const startY = 600;
      const endY = 200;

      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: startX, y: startY }],
      });

      for (let i = 1; i <= 5; i++) {
        const currentY = startY - (startY - endY) * (i / 5);
        await client.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: startX, y: currentY }],
        });
        await sleep(10);
      }

      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });

      await sleep(100);

      const scrollAfter = await page.evaluate(() => window.scrollY);
      expect(scrollAfter - scrollBefore).toBeGreaterThan(50);
    });

    test('only drag-handle has touch-action: none (not entire rows)', async () => {
      await page.click('[data-tab="modes"]');
      await sleep(50);

      const touchActionIssues = await page.evaluate(() => {
        const issues: string[] = [];
        const draggableRows = document.querySelectorAll('.draggable');
        for (const row of Array.from(draggableRows)) {
          if (getComputedStyle(row).touchAction === 'none') {
            issues.push('draggable row has touch-action: none');
          }
        }
        return issues;
      });

      expect(touchActionIssues).toHaveLength(0);
    });

    test('drag-handle has touch-action: none for proper drag behavior', async () => {
      await page.click('[data-tab="modes"]');
      await sleep(50);

      const handleTouchAction = await page.$eval('.drag-handle', (el) => {
        return getComputedStyle(el).touchAction;
      });

      expect(handleTouchAction).toBe('none');
    });
  });

  describe('Form inputs', () => {
    beforeAll(async () => {
      await setupPage();
    });

    test('capacity limit input accepts numeric values', async () => {
      await page.click('[data-tab="budget"]');
      await sleep(50);

      const input = await page.$('#capacity-limit');
      expect(input).toBeTruthy();

      await input?.click({ clickCount: 3 });
      await input?.type('15.5');

      const value = await page.$eval('#capacity-limit', (el) => (el as HTMLInputElement).value);
      expect(value).toBe('15.5');
    });

    test('mode target inputs are present in modes tab', async () => {
      await page.click('[data-tab="modes"]');
      await sleep(50);

      const inputs = await page.$$('.mode-target-input');
      expect(inputs.length).toBeGreaterThan(0);
    });

    test('mode target inputs fit 0.5 increment values without overflow', async () => {
      const mockScript = `
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
          [
            { name: 'Varmepumpe stue', temp: 22.5 },
            { name: 'Gulvvarme bad', temp: 24.5 },
            { name: 'Panelovn', temp: 19.5 },
          ].forEach((dev, i) => {
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
      `;

      await recreatePage({
        viewport: { width: 480, height: 800 },
        isMobile: false,
        hasTouch: false,
      });

      const html = prepareHtml(mockScript);
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      await sleep(50);

      const hasOverflow = await page.evaluate(() => {
        return document.body.scrollWidth > document.documentElement.clientWidth;
      });
      expect(hasOverflow).toBe(false);

      const inputValues = await page.$$eval('.mode-target-input', (els) => {
        const values: string[] = [];
        for (const el of els) {
          values.push((el as HTMLInputElement).value);
        }
        return values;
      });
      expect(inputValues).toContain('22.5');
      expect(inputValues).toContain('24.5');
      expect(inputValues).toContain('19.5');
    });
  });

  describe('Accessibility', () => {
    beforeAll(async () => {
      await setupPage();
    });

    test('tabs have proper ARIA attributes', async () => {
      const tabs = await page.$$eval('.tab', (els) => {
        const tabEntries: Array<{ role: string | null; ariaSelected: string | null }> = [];
        for (const el of els) {
          tabEntries.push({
            role: el.getAttribute('role'),
            ariaSelected: el.getAttribute('aria-selected'),
          });
        }
        return tabEntries;
      });

      tabs.forEach((tab) => {
        expect(tab.role).toBe('tab');
        expect(tab.ariaSelected).toMatch(/true|false/);
      });
    });

    test('tab container has tablist role', async () => {
      const role = await page.$eval('.tabs', (el) => el.getAttribute('role'));
      expect(role).toBe('tablist');
    });

    test('lists have proper list roles', async () => {
      const deviceList = await page.$eval('#device-list', (el) => ({
        role: el.getAttribute('role'),
        tag: el.tagName.toLowerCase(),
      }));

      // Accept either explicit ARIA list role on a div or native list semantics.
      expect(['ul', 'ol', 'div']).toContain(deviceList.tag);
      const isAriaListDiv = deviceList.tag === 'div' && deviceList.role === 'list';
      const isNativeList = ['ul', 'ol'].includes(deviceList.tag) && deviceList.role === null;
      expect(isAriaListDiv || isNativeList).toBe(true);
    });
  });

  describe('Visual styling', () => {
    beforeAll(async () => {
      await setupPage();
    });

    test('active tab has correct styling', async () => {
      const activeTabBg = await page.$eval('.tab.active', (el) => {
        return getComputedStyle(el).background;
      });
      expect(activeTabBg).toContain('linear-gradient');
    });

    test('cards have backdrop blur effect', async () => {
      const backdropFilter = await page.$eval('.card', (el) => {
        return getComputedStyle(el).backdropFilter;
      });
      expect(backdropFilter).toContain('blur');
    });

    test('price status badge exists on price tab', async () => {
      await page.click('[data-tab="price"]');
      await sleep(50);

      const badge = await page.$('#price-status-badge');
      expect(badge).toBeTruthy();
      // Badge is only visible for warn states; hidden otherwise
    });
  });

  describe('Overview layout', () => {
    const setupOverviewPage = async (devices: Array<{
      name: string;
      state: string;
      reason: string;
      load: string;
    }>, viewport: { width: number; height: number } = { width: 480, height: 800 }) => {
      const devicesJson = JSON.stringify(devices);
      const mockScript = `
        document.addEventListener('DOMContentLoaded', () => {
          const tabs = document.querySelectorAll('.tab');
          const panels = document.querySelectorAll('.panel');
          tabs.forEach(tab => {
            const isOverview = tab.dataset.tab === 'overview';
            tab.classList.toggle('active', isOverview);
            tab.setAttribute('aria-selected', isOverview ? 'true' : 'false');
          });
          panels.forEach(p => {
            p.classList.toggle('hidden', p.dataset.panel !== 'overview');
          });
          
          const planList = document.getElementById('plan-cards');
          const planHero = document.getElementById('plan-hero');
          const planEmpty = document.getElementById('plan-empty');
          const legacySurface = document.getElementById('plan-legacy-surface');
          const redesignSurface = document.getElementById('plan-redesign-surface');
          
          if (planEmpty) planEmpty.hidden = true;
          if (legacySurface) legacySurface.hidden = true;
          if (redesignSurface) redesignSurface.hidden = false;
          if (planHero) {
            planHero.innerHTML = [
              '<div class="plan-hero__top">',
              '  <div class="plan-hero__heading">',
              '    <p class="eyebrow plan-hero__eyebrow">Overview</p>',
              '    <div class="plan-hero__headline-row"><h2 class="plan-hero__value">4.2 kW</h2><p class="plan-hero__limit">of 9.5 kW soft limit</p></div>',
              '    <p class="plan-hero__message">5.3 kW to spare</p>',
              '  </div>',
              '  <div class="plan-hero__status"><span class="plan-chip plan-chip--ok">Live</span><span class="plan-hero__age">10s ago</span></div>',
              '</div>',
              '<div class="plan-hero__bar-wrap">',
              '  <div class="plan-hero__bar">',
              '    <div class="plan-hero__segments">',
              '      <span class="plan-hero__seg plan-hero__seg--managed" style="flex-basis:44%"></span>',
              '      <span class="plan-hero__seg plan-hero__seg--other" style="flex-basis:12%"></span>',
              '      <span class="plan-hero__seg plan-hero__seg--free" style="flex-basis:44%"></span>',
              '    </div>',
              '    <span class="plan-hero__tick plan-hero__tick--soft" style="left:100%"></span>',
              '  </div>',
              '</div>',
            ].join('');
          }

          const devices = ${devicesJson};
          devices.forEach(dev => {
            const row = document.createElement('div');
            row.className = 'device-row plan-card';
            row.dataset.deviceId = dev.name.replace(/\\s+/g, '-').toLowerCase();
            row.innerHTML = [
              '<div class="plan-card__header">',
              '  <span class="plan-card__icon"><svg viewBox="0 0 24 24"></svg></span>',
              '  <div class="plan-card__title-wrap"><h3 class="plan-card__title">' + dev.name + '</h3></div>',
              '  <div class="plan-card__chips"><span class="plan-state-chip plan-state-chip--active">' + dev.state + '</span></div>',
              '</div>',
              '<div class="plan-card__load">',
              '  <div class="plan-card__load-track"><span class="plan-card__load-fill" style="width:52%"></span><span class="plan-card__load-tick" style="left:80%"></span></div>',
              '  <span class="plan-card__load-label">' + dev.load + '</span>',
              '</div>',
              '<p class="plan-card__reason">' + dev.reason + '</p>',
            ].join('');
            planList.appendChild(row);
          });
        });
      `;

      await recreatePage({
        viewport,
        isMobile: false,
        hasTouch: false,
      });

      const html = prepareHtml(mockScript);
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      await sleep(50);
    };

    test('renders the hero bar and three-row overview cards', async () => {
      await setupOverviewPage([
        {
          name: 'Bathroom Floor',
          state: 'Held',
          load: '0.2 / 1.4 kW',
          reason: 'Waiting for room to reopen — 23 min below target',
        },
      ]);

      expect(await page.locator('.plan-hero__segments .plan-hero__seg').count()).toBe(3);
      expect(await page.locator('.plan-card').count()).toBe(1);
      expect(await page.textContent('.plan-card__title')).toContain('Bathroom Floor');
      expect(await page.textContent('.plan-card__load-label')).toContain('0.2 / 1.4 kW');
      expect(await page.textContent('.plan-card__reason')).toContain('Waiting for room to reopen');
    });

    test('keeps overview cards within 480px without horizontal overflow', async () => {
      await setupOverviewPage([
        {
          name: 'Very Long Device Name That Could Cause Issues On Narrow Homey Layouts',
          state: 'Reactivating',
          load: '0.0 / 7.4 kW',
          reason: 'insufficient headroom to restore (need 7.20kW, available 1.40kW)',
        },
      ]);

      const overflowInfo = await page.evaluate(() => ({
        hasHorizontalScroll: document.body.scrollWidth > document.documentElement.clientWidth,
        titleOverflow: Array.from(document.querySelectorAll('.plan-card__title')).some((el) => el.scrollWidth > el.clientWidth),
        reasonOverflow: Array.from(document.querySelectorAll('.plan-card__reason')).some((el) => el.scrollWidth > el.clientWidth),
      }));

      expect(overflowInfo.hasHorizontalScroll).toBe(false);
      expect(overflowInfo.reasonOverflow).toBe(false);
      expect(overflowInfo.titleOverflow).toBe(false);
    });

    test('keeps overview content within 320px without horizontal scroll', async () => {
      await setupOverviewPage([
        {
          name: 'Long Device Name',
          state: 'Active',
          load: '1.2 / 1.6 kW',
          reason: 'restore 21° -> 22° (need 0.40kW)',
        },
      ], { width: 320, height: 600 });

      const overflowInfo = await page.evaluate(() => {
        const viewportWidth = document.documentElement.clientWidth;
        const cards = document.querySelectorAll('.plan-card, .plan-hero, .plan-hour-strip');

        let lineOverflow = false;
        cards.forEach((line) => {
          const rect = (line as HTMLElement).getBoundingClientRect();
          if (rect.right > viewportWidth) lineOverflow = true;
        });

        return {
          lineOverflow,
          hasHorizontalScroll: document.body.scrollWidth > viewportWidth,
        };
      });

      expect(overflowInfo.lineOverflow).toBe(false);
      expect(overflowInfo.hasHorizontalScroll).toBe(false);
    });
  });

  describe('Price optimization section', () => {
    beforeAll(async () => {
      await setupPage({ viewport: { width: 480, height: 800 } });
      await page.click('[data-tab="price"]');
      await sleep(50);
    });

    test('price optimization header aligns with row columns', async () => {
      const header = await page.$('.price-optimization-header');
      expect(header).toBeTruthy();

      const headerStyle = await page.$eval('.price-optimization-header', (el) => {
        const style = getComputedStyle(el);
        return { display: style.display, gridTemplateColumns: style.gridTemplateColumns };
      });

      expect(headerStyle.display).toBe('grid');
    });

    test('price optimization rows have grid layout', async () => {
      const rows = await page.$$('.price-optimization-row');
      expect(rows.length).toBeGreaterThan(0);

      const rowStyle = await page.$eval('.price-optimization-row', (el) => {
        const style = getComputedStyle(el);
        return { display: style.display, gridTemplateColumns: style.gridTemplateColumns };
      });

      expect(rowStyle.display).toBe('grid');
    });

    test('device name and inputs are on same row', async () => {
      const row = await page.$('.price-optimization-row');
      expect(row).toBeTruthy();

      const nameBox = await page.$eval('.price-optimization-row .device-row__name', (el) => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      });
      const inputBox = await page.$eval('.price-optimization-row .price-opt-input', (el) => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      });

      expect(nameBox.bottom).toBeGreaterThanOrEqual(inputBox.top);
      expect(inputBox.bottom).toBeGreaterThanOrEqual(nameBox.top);
    });

    test('inputs fit within viewport at 480px', async () => {
      const inputRights = await page.$$eval('.price-optimization-row .price-opt-input', (els) => {
        const rights: number[] = [];
        for (const el of els) {
          rights.push(el.getBoundingClientRect().right);
        }
        return rights;
      });

      for (const right of inputRights) {
        expect(right).toBeLessThanOrEqual(480);
      }
    });

    test('each row has device name and 3 inputs (no checkbox)', async () => {
      const rowContent = await page.$eval('.price-optimization-row', (row) => {
        const name = row.querySelector('.device-row__name');
        const inputs = row.querySelectorAll('input[type="number"]');
        const checkbox = row.querySelector('input[type="checkbox"]');
        return {
          hasName: Boolean(name),
          nameText: name?.textContent,
          inputCount: inputs.length,
          hasCheckbox: Boolean(checkbox),
        };
      });

      expect(rowContent.hasName).toBe(true);
      expect(rowContent.nameText).toBeTruthy();
      expect(rowContent.inputCount).toBe(3);
      expect(rowContent.hasCheckbox).toBe(false);
    });
  });

  describe('Device detail panel', () => {
    const setupPageWithDeviceDetail = async () => {
      const mockScript = `
        // Helper functions for device detail
        function openDeviceDetail(deviceId, deviceName) {
          const overlay = document.getElementById('device-detail-overlay');
          const title = document.getElementById('device-detail-title');
          if (overlay && title) {
            title.textContent = deviceName;
            overlay.hidden = false;
            overlay.dataset.deviceId = deviceId;
            
            // Populate mode temperatures
            const modeList = document.getElementById('device-detail-modes');
            if (modeList) {
              modeList.innerHTML = '';
              ['Home', 'Away', 'Night'].forEach(mode => {
                const card = document.createElement('div');
                card.className = 'mode-card';
                card.innerHTML = '<span class="mode-card__name">' + mode + '</span>' +
                  '<input type="number" class="mode-target-input" value="21" step="0.5">';
                modeList.appendChild(card);
              });
            }
          }
        }
        
        function closeDeviceDetail() {
          const overlay = document.getElementById('device-detail-overlay');
          if (overlay) overlay.hidden = true;
        }
        
        document.addEventListener('DOMContentLoaded', () => {
          const deviceList = document.getElementById('device-list');
          const emptyState = document.getElementById('empty-state');
          if (emptyState) emptyState.hidden = true;
          
          // Add test devices
          ['Test Device 1', 'Test Device 2', 'Test Device 3'].forEach((name, index) => {
            const row = document.createElement('div');
            row.className = 'device-row';
            row.setAttribute('role', 'listitem');
            row.dataset.deviceId = 'device-' + (index + 1);
            
            const nameWrap = document.createElement('div');
            nameWrap.className = 'device-row__name';
            nameWrap.textContent = name;
            nameWrap.style.cursor = 'pointer';
            nameWrap.addEventListener('click', () => openDeviceDetail('device-' + (index + 1), name));
            
            const managedLabel = document.createElement('label');
            managedLabel.className = 'checkbox-icon';
            const managedInput = document.createElement('input');
            managedInput.type = 'checkbox';
            managedInput.checked = true;
            managedLabel.appendChild(managedInput);

            const ctrlLabel = document.createElement('label');
            ctrlLabel.className = 'checkbox-icon';
            const ctrlInput = document.createElement('input');
            ctrlInput.type = 'checkbox';
            ctrlInput.checked = true;
            ctrlLabel.appendChild(ctrlInput);
            
            const priceLabel = document.createElement('label');
            priceLabel.className = 'checkbox-icon';
            const priceInput = document.createElement('input');
            priceInput.type = 'checkbox';
            priceInput.checked = index < 2;
            priceLabel.appendChild(priceInput);
            
            row.append(nameWrap, managedLabel, ctrlLabel, priceLabel);
            deviceList.appendChild(row);
          });
          
          // Close button listener
          const closeBtn = document.getElementById('device-detail-close');
          if (closeBtn) {
            closeBtn.addEventListener('click', closeDeviceDetail);
          }
          
          // Close on overlay click (but not panel content)
          const overlay = document.getElementById('device-detail-overlay');
          if (overlay) {
            overlay.addEventListener('click', (e) => {
              if (e.target === overlay) closeDeviceDetail();
            });
          }
          
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
          tabs.forEach(tab => {
            const isDevices = tab.dataset.tab === 'devices';
            tab.classList.toggle('active', isDevices);
            tab.setAttribute('aria-selected', isDevices ? 'true' : 'false');
          });
          panels.forEach(p => {
            p.classList.toggle('hidden', p.dataset.panel !== 'devices');
          });

          const overshootSelect = document.getElementById('device-detail-overshoot');
          const overshootRow = document.getElementById('device-detail-overshoot-temp-row');
          const overshootInput = document.getElementById('device-detail-overshoot-temp');
          const updateOvershoot = () => {
            if (!overshootSelect || !overshootRow) return;
            const isTemp = overshootSelect.value === 'set_temperature';
            overshootRow.hidden = !isTemp;
            if (overshootInput) overshootInput.disabled = !isTemp;
          };
          if (overshootSelect) {
            overshootSelect.addEventListener('change', updateOvershoot);
          }
          updateOvershoot();
        });
      `;

      await recreatePage({
        viewport: { width: 480, height: 800 },
        isMobile: false,
        hasTouch: false,
      });

      const html = prepareHtml(mockScript);
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      await sleep(50);
    };

    beforeAll(async () => {
      await setupPageWithDeviceDetail();
    });

    test('device detail overlay is hidden by default', async () => {
      const overlay = await page.$('#device-detail-overlay');
      expect(overlay).toBeTruthy();

      const isHidden = await page.$eval('#device-detail-overlay', (el) => (el as HTMLElement).hidden);
      expect(isHidden).toBe(true);
    });

    test('clicking device name opens detail panel', async () => {
      // Click on first device name
      await page.click('.device-row__name');

      const isHidden = await page.$eval('#device-detail-overlay', (el) => (el as HTMLElement).hidden);
      expect(isHidden).toBe(false);
    });

    test('device detail shows correct device name', async () => {
      // Panel should already be open from previous test, but make sure
      const isHidden = await page.$eval('#device-detail-overlay', (el) => (el as HTMLElement).hidden);
      if (isHidden) await page.click('.device-row__name');

      const title = await page.$eval('#device-detail-title', (el) => el.textContent);
      expect(title).toBe('Test Device 1');
    });

    test('close button closes detail panel', async () => {
      // Ensure panel is open
      let isHidden = await page.$eval('#device-detail-overlay', (el) => (el as HTMLElement).hidden);
      if (isHidden) await page.click('.device-row__name');

      // Click close button
      await page.click('#device-detail-close');

      // Verify panel is closed
      isHidden = await page.$eval('#device-detail-overlay', (el) => (el as HTMLElement).hidden);
      expect(isHidden).toBe(true);
    });

    test('clicking overlay backdrop closes detail panel', async () => {
      // Open panel
      await page.click('.device-row__name');

      // Verify panel is open
      let isHidden = await page.$eval('#device-detail-overlay', (el) => (el as HTMLElement).hidden);
      expect(isHidden).toBe(false);

      // Click on overlay backdrop (outside panel content) using evaluate for more control
      await page.evaluate(() => {
        const overlay = document.getElementById('device-detail-overlay');
        if (overlay) {
          // Dispatch a click event directly on the overlay (not its children)
          const event = new MouseEvent('click', { bubbles: true });
          Object.defineProperty(event, 'target', { value: overlay, writable: false });
          overlay.dispatchEvent(event);
        }
      });

      // Verify panel is closed
      isHidden = await page.$eval('#device-detail-overlay', (el) => (el as HTMLElement).hidden);
      expect(isHidden).toBe(true);
    });

    test('device detail has control checkboxes', async () => {
      await page.click('.device-row__name');

      const managedCheckbox = await page.$('#device-detail-managed');
      const controllableCheckbox = await page.$('#device-detail-controllable');
      const priceOptCheckbox = await page.$('#device-detail-price-opt');

      expect(managedCheckbox).toBeTruthy();
      expect(controllableCheckbox).toBeTruthy();
      expect(priceOptCheckbox).toBeTruthy();
    });

    test('device detail shows mode temperatures section', async () => {
      // Panel should be open from previous test
      const isHidden = await page.$eval('#device-detail-overlay', (el) => (el as HTMLElement).hidden);
      if (isHidden) await page.click('.device-row__name');

      const modeList = await page.$('#device-detail-modes');
      expect(modeList).toBeTruthy();

      // Check that modes are populated
      const modeCards = await page.$$('#device-detail-modes .mode-card');
      expect(modeCards.length).toBeGreaterThan(0);
    });

    test('device detail shows delta inputs section', async () => {
      // Panel should be open
      const isHidden = await page.$eval('#device-detail-overlay', (el) => (el as HTMLElement).hidden);
      if (isHidden) await page.click('.device-row__name');

      const cheapDelta = await page.$('#device-detail-cheap-delta');
      const expensiveDelta = await page.$('#device-detail-expensive-delta');

      expect(cheapDelta).toBeTruthy();
      expect(expensiveDelta).toBeTruthy();
    });

    test('overshoot temperature input appears when choosing set temperature', async () => {
      const isHidden = await page.$eval('#device-detail-overlay', (el) => (el as HTMLElement).hidden);
      if (isHidden) await page.click('.device-row__name');

      const initiallyHidden = await page.$eval('#device-detail-overshoot-temp-row', (el) => (el as HTMLElement).hidden);
      expect(initiallyHidden).toBe(true);

      await page.selectOption('#device-detail-overshoot', 'set_temperature');

      const hiddenAfterSelect = await page.$eval('#device-detail-overshoot-temp-row', (el) => (el as HTMLElement).hidden);
      expect(hiddenAfterSelect).toBe(false);

      const inputDisabled = await page.$eval('#device-detail-overshoot-temp', (el) => (el as HTMLInputElement).disabled);
      expect(inputDisabled).toBe(false);
    });

    test('device detail panel fits within viewport', async () => {
      // Ensure panel is open
      const isHidden = await page.$eval('#device-detail-overlay', (el) => (el as HTMLElement).hidden);
      if (isHidden) await page.click('.device-row__name');

      const panelBox = await page.$eval('#device-detail-panel', (el) => {
        const rect = el.getBoundingClientRect();
        return { right: rect.right, bottom: rect.bottom };
      });

      // Panel should fit within 480px width viewport
      expect(panelBox.right).toBeLessThanOrEqual(480);
    });

    test('device detail header has close button and title', async () => {
      // Ensure panel is open
      const isHidden = await page.$eval('#device-detail-overlay', (el) => (el as HTMLElement).hidden);
      if (isHidden) await page.click('.device-row__name');

      const headerContent = await page.$eval('#device-detail-panel .slide-panel__header', (el) => {
        const closeBtn = el.querySelector('#device-detail-close');
        const title = el.querySelector('#device-detail-title');
        return {
          hasCloseBtn: Boolean(closeBtn),
          hasTitle: Boolean(title),
        };
      });

      expect(headerContent.hasCloseBtn).toBe(true);
      expect(headerContent.hasTitle).toBe(true);
    });
  });
});
