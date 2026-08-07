import { expect, test, type Page } from './fixtures/test';
import {
  gotoApp,
  installRentalMeterDeviceList,
  seedHeldRentalArea,
  seedRentalArea,
  pickHomeScope,
  seedRentalMeterSnapshot,
  seedStubSetting,
} from './fixtures/homes';

/* -------------------------------------------------------------------------- *
 * Per-home Limits & safety flow (multi-home U3): the shell's global scope bar
 * appears once a meter area exists, picking the area shows its editor plus the
 * activation notice (areas default to simulation), turning ON the positive
 * "Control devices in this area" toggle starts device control by persisting
 * `capacity_dry_run:<homeId>` = false, and a cap edit persists
 * `capacity_limit_kw:<homeId>`. The Main home keeps its static form and bare
 * keys.
 * -------------------------------------------------------------------------- */

const AREA_ID = 'h_11111111';

const openLimitsPanel = async (page: Page): Promise<void> => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  const navCard = page.locator('.settings-nav-card[data-settings-target="limits"]');
  await navCard.scrollIntoViewIfNeeded();
  await navCard.click();
  await expect(page.locator('#limits-panel')).toBeVisible();
};

const readStubSetting = (page: Page, key: string): Promise<unknown> => page.evaluate(
  (settingKey) => (window as unknown as {
    Homey: { __stub: { getSetting: (k: string) => unknown } };
  }).Homey.__stub.getSetting(settingKey),
  key,
);

test('single-home user sees the unchanged static form, no scope bar', async ({ page }) => {
  await gotoApp(page);
  await openLimitsPanel(page);
  await expect(page.locator('#home-scope-chip')).toHaveCount(0);
  await expect(page.locator('#settings-limits-form')).toBeVisible();
  await expect(page.locator('#settings-capacity-limit')).toBeVisible();
  // With no meter areas the Main-home copy is untouched: "your" still means the
  // whole house, and the app-global settings card is just part of the page.
  await expect(page.locator('#settings-capacity-limit-hint')).toHaveText(
    'Your grid tariff step (effekttrinn) — PELS keeps each hour’s average power under this.',
  );
  await expect(page.locator('#settings-limits-global')).toBeVisible();
  // Layout identity: the scope bar's mount stays display:none, so it claims no
  // `main.screen` grid row and the shell is unchanged for a single-meter home.
  const scopeBarBox = await page.evaluate(() => {
    const mount = document.getElementById('home-scope-bar')!;
    return {
      hidden: mount.hidden,
      display: window.getComputedStyle(mount).display,
      height: mount.getBoundingClientRect().height,
    };
  });
  expect(scopeBarBox).toEqual({ hidden: true, display: 'none', height: 0 });
});

test('a meter area activates control: switch, turn control on, set a cap', async ({ page }) => {
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await seedRentalArea(page);
  await openLimitsPanel(page);

  // The scope bar now offers Main home + the meter area; Main keeps the static form.
  const scopeChip = page.locator('#home-scope-chip');
  await expect(scopeChip).toBeVisible();
  await expect(page.locator('#settings-limits-form')).toBeVisible();

  // Seeding an area must reach the app the way a real `homes_config` write does,
  // so the global banner shows its production scoped copy. A silent store poke
  // left every capture from these fixtures on the single-home banner.
  await expect(page.locator('#dry-run-banner')).toContainText(
    'Main home simulation on — Main home devices stay as-is',
  );
  // App-global settings sit outside the scope bar's claim, and the Main-home
  // hard-cap hint names its home once the house is split.
  await expect(page.locator('#settings-limits-global')).toBeVisible();
  await expect(page.locator('#settings-capacity-limit-hint'))
    .toContainText('The Main home’s grid tariff step');
  await expect(page.locator('#limits-title')).toHaveText('Limits & safety');

  // Pick the meter area: the static form hides, the per-home editor appears, and
  // — because a fresh area defaults to simulation — the activation notice shows.
  await pickHomeScope(page, AREA_ID);
  await expect(page.locator('#home-limits-hard-cap')).toBeVisible();
  await expect(page.locator('#settings-limits-form')).toBeHidden();
  await expect(page.locator('#home-limits-sim-notice')).toBeVisible();
  await expect(page.locator('#home-limits-sim-notice')).toContainText('turn on control');
  // With the bar on screen the home is named once, by the chip. Restating it in
  // the title 40 px below — in the one place that truncates — would read as a
  // defect, so the suffix stays off until the bar scrolls away (below).
  await expect(page.locator('#limits-title')).toHaveText('Limits & safety');
  await expect(page.locator('#home-limits-status')).toContainText('Status now · Rental unit');
  // App-global settings step out of the area's scope claim, leaving an account.
  await expect(page.locator('#settings-limits-global')).toBeHidden();
  await expect(page.locator('#home-limits-global-note'))
    .toContainText('the whole-home meter is the Main home’s own meter');

  // Turn control ON — the activation step. The suffixed key persists false
  // (dry-run off) and the notice clears.
  await page.locator('#home-limits-simulation-switch').click();
  await expect(page.locator('#home-limits-sim-notice')).toHaveCount(0);
  await expect.poll(() => readStubSetting(page, `capacity_dry_run:${AREA_ID}`)).toBe(false);
  // The controller disables the switch while its write is in flight, so waiting
  // for it to come back is the signal that the write COMMITTED and the editor
  // repainted. Without it the repaint can land between the fill and the blur
  // below, resetting the field to its stored value so the blur commits nothing —
  // an intermittent failure that reads as "the cap never persisted".
  await expect(page.locator('#home-limits-simulation-switch')).toBeEnabled();

  // Set a hard cap for the area — persists the suffixed key, never the bare one.
  await page.locator('#home-limits-hard-cap').fill('9');
  await expect(page.locator('#home-limits-hard-cap')).toHaveValue('9');
  await page.locator('#home-limits-hard-cap').blur();
  await expect.poll(() => readStubSetting(page, `capacity_limit_kw:${AREA_ID}`)).toBe(9);
  await expect(readStubSetting(page, 'capacity_dry_run')).resolves.not.toBe(false);
});

test('the scope bar holds its home at every scroll position', async ({ page }) => {
  // A short viewport so the panel definitely scrolls in every project. The bar
  // is sticky: the whole point is that the scope survives scrolling, which the
  // panel's own app bar cannot do (it is not sticky and leaves the viewport).
  await page.setViewportSize({ width: 320, height: 420 });
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await seedRentalArea(page);
  await openLimitsPanel(page);
  await pickHomeScope(page, AREA_ID);
  await expect(page.locator('#home-limits-hard-cap')).toBeVisible();

  // The home is named once, by the chip — the title never restates it.
  await expect(page.locator('#limits-title')).toHaveText('Limits & safety');
  await expect(page.locator('#home-scope-chip')).toContainText('Rental unit');

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(async () => page.evaluate(() => {
    const appbar = document.querySelector('#limits-panel .pels-appbar')!.getBoundingClientRect();
    return appbar.bottom <= 0;
  })).toBe(true);

  // The app bar has scrolled away; the scope has not.
  await expect(page.locator('#home-scope-chip')).toBeVisible();
  await expect(page.locator('#home-scope-chip')).toContainText('Rental unit');
  const stuck = await page.evaluate(() => (
    document.getElementById('home-scope-bar')!.getBoundingClientRect().top
  ));
  expect(stuck).toBeGreaterThanOrEqual(0);
  expect(stuck).toBeLessThanOrEqual(2);
  await expect(page.locator('#limits-title')).toHaveText('Limits & safety');
});

test('a long unbroken area name cannot overflow the 320 px panel', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  // No spaces to break on: the pathological case for both the picker and the
  // scoped status heading, whose sibling chip cannot wrap.
  await seedRentalArea(page, 'Leilighetiunderetasjenmedekstralangtnavn');
  await openLimitsPanel(page);
  await pickHomeScope(page, AREA_ID);
  await expect(page.locator('#home-limits-status')).toBeVisible();

  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    status: (() => {
      const card = document.querySelector('#home-limits-status')!;
      return card.scrollWidth - card.clientWidth;
    })(),
  }));
  expect(overflow.doc).toBeLessThanOrEqual(0);
  expect(overflow.status).toBeLessThanOrEqual(0);
});

test('a Main-home-only deep link selects the Main home before landing', async ({ page }) => {
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await seedRentalArea(page);
  await openLimitsPanel(page);
  await pickHomeScope(page, AREA_ID);
  await expect(page.locator('#settings-limits-global')).toBeHidden();

  // The stale-data banner promises the Power source control. Following it while
  // an area is selected must not land on a page where that control is hidden.
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.evaluate(() => { document.getElementById('stale-data-banner')!.hidden = false; });
  await page.locator('#stale-data-action').click();
  await expect(page.locator('#limits-panel')).toBeVisible();
  await expect(page.locator('#settings-limits-global')).toBeVisible();
  await expect(page.locator('#settings-power-source')).toBeVisible();
  await expect(page.locator('#home-scope-chip')).toContainText('Main home');
});

test('the scope picker reopens after a pick, and switches back to the Main home', async ({ page }) => {
  // Regression: Material closes its own menu without going through Preact, so a
  // menu kept mounted across re-renders reported itself open while its surface
  // stayed collapsed — the picker worked exactly once per page load, stranding
  // the user in whichever scope they first chose.
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await seedRentalArea(page);
  await openLimitsPanel(page);

  await pickHomeScope(page, AREA_ID);
  await expect(page.locator('#home-limits-hard-cap')).toBeVisible();

  // Second open: the picker must still work, and take the user back to Main.
  await pickHomeScope(page, 'main');
  await expect(page.locator('#limits-title')).toHaveText('Limits & safety');
  await expect(page.locator('#settings-limits-form')).toBeVisible();
  await expect(page.locator('#settings-limits-global')).toBeVisible();

  // And a third time, back into the area.
  await pickHomeScope(page, AREA_ID);
  await expect(page.locator('#home-limits-hard-cap')).toBeVisible();
});

test('the scope picker reopens after outside-click and Escape dismissals', async ({ page }) => {
  // Regression: Material announces every self-dismissal with its lowercase
  // `closed` event, but a Preact `onClosed` prop binds the case-sensitive type
  // `Closed`, which never fires. Selection dismissal was covered by the item's
  // own click handler, so only these two paths left the open flag stale — the
  // next chip tap then unmounted an already-closed menu and appeared dead.
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await seedRentalArea(page);
  await openLimitsPanel(page);

  const chip = page.locator('#home-scope-chip');
  const mainOption = page.locator('#home-scope-option-main');

  // Outside click: the bar's own label sits beside the chip, outside the menu
  // surface, and is sticky, so the tap target cannot be covered by the menu.
  await chip.click();
  await expect(mainOption).toBeVisible();
  await page.locator('.scope-bar__label').click();
  await expect(mainOption).toHaveCount(0);
  // One tap must reopen — a dismissal must not cost the next open a dead tap.
  await chip.click();
  await expect(mainOption).toBeVisible();

  // Escape, same contract. Escape is a menu-keydown, and Material only moves
  // focus onto the first item once the opening animation settles — pressing
  // before that lands the key on the chip, where nothing listens.
  await expect(mainOption).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(mainOption).toHaveCount(0);
  await chip.click();
  await expect(mainOption).toBeVisible();

  // And the reopened menu still actually picks.
  await page.locator(`#home-scope-option-${AREA_ID}`).click();
  await expect(page.locator('#home-limits-hard-cap')).toBeVisible();
});

test('Main simulation banner stays truthful while a meter area actively controls devices', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addInitScript(() => {
    const stubWindow = window as Window & {
      __PELS_HOMEY_STUB__?: { settings?: Record<string, unknown> };
    };
    const existing = stubWindow.__PELS_HOMEY_STUB__ ?? {};
    stubWindow.__PELS_HOMEY_STUB__ = {
      ...existing,
      settings: {
        ...(existing.settings ?? {}),
        capacity_dry_run: true,
        'capacity_dry_run:h_11111111': false,
        homes_config: {
          activationVersion: 1,
          subHomes: [{
            homeId: 'h_11111111',
            name: 'Rental unit',
            rootZoneId: 'z_rental',
            meterDeviceId: 'dev_rental_meter',
          }],
        },
        'pels_status:h_11111111': {
          controlledKw: 2.5,
          uncontrolledKw: 1.5,
          powerKnown: true,
          hasLivePowerSample: true,
          devicesOff: 1,
          limitReason: 'hourly',
        },
      },
    };
  });
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await openLimitsPanel(page);
  await pickHomeScope(page, AREA_ID);

  await expect(page.locator('#home-limits-status-chip')).toHaveText('Active');
  await expect(page.locator('#home-limits-status-line')).toContainText('Limiting 1 device');
  await expect(page.locator('#dry-run-banner')).toContainText(
    'Main home simulation on — Main home devices stay as-is',
  );
  await expect(page.locator('#simulation-disable-button')).toHaveText('Turn off Main home simulation');
  const bannerLayout = await page.evaluate(() => {
    const banner = document.querySelector('#dry-run-banner')!.getBoundingClientRect();
    const text = document.querySelector('#dry-run-banner-text')!.getBoundingClientRect();
    const action = document.querySelector('#simulation-disable-button')!.getBoundingClientRect();
    return {
      height: Math.round(banner.height),
      textWidth: Math.round(text.width),
      textBottom: Math.round(text.bottom),
      actionTop: Math.round(action.top),
    };
  });
  expect(bannerLayout.textWidth).toBeGreaterThanOrEqual(180);
  expect(bannerLayout.actionTop).toBeGreaterThanOrEqual(bannerLayout.textBottom - 1);
  expect(bannerLayout.height).toBeLessThanOrEqual(150);
});

test('simulation banner keeps a conservative scope across transient and realtime roster changes', async ({ page }) => {
  await gotoApp(page);
  const banner = page.locator('#dry-run-banner');
  const action = page.locator('#simulation-disable-button');
  await expect(banner).toContainText('Simulation on — devices stay as-is');

  await page.evaluate(() => {
    const stub = (window as unknown as {
      Homey: {
        __stub: {
          emitSettingsSet: (key: string) => void;
          setSetting: (key: string, value: unknown) => void;
        };
      };
    }).Homey.__stub;
    stub.setSetting('homes_config_initialized', true);
    stub.setSetting('homes_config', undefined);
    stub.emitSettingsSet('homes_config_initialized');
  });
  await expect(banner).toContainText('Main home simulation on — Main home devices stay as-is');
  await expect(action).toHaveText('Turn off Main home simulation');

  await page.evaluate(() => {
    const stub = (window as unknown as {
      Homey: {
        __stub: {
          emitSettingsSet: (key: string) => void;
          setSetting: (key: string, value: unknown) => void;
        };
      };
    }).Homey.__stub;
    stub.setSetting('homes_config', {
      activationVersion: 1,
      subHomes: [{
        homeId: 'h_11111111',
        name: 'Rental unit',
        rootZoneId: 'z_rental',
        meterDeviceId: 'dev_rental_meter',
      }],
    });
    stub.emitSettingsSet('homes_config');
  });
  await expect(banner).toContainText('Main home simulation on — Main home devices stay as-is');

  await page.evaluate(() => {
    const stub = (window as unknown as {
      Homey: {
        __stub: {
          emitSettingsSet: (key: string) => void;
          setSetting: (key: string, value: unknown) => void;
        };
      };
    }).Homey.__stub;
    stub.setSetting('homes_config', { activationVersion: 1, subHomes: [] });
    stub.emitSettingsSet('homes_config');
  });
  await expect(banner).toContainText('Simulation on — devices stay as-is');
  await expect(action).toHaveText('Turn off simulation');
});

test('a simulating area surfaces on the global banner while Main is live, until control turns on', async ({ page }) => {
  // The inverse of the Main-scoped chain above: Main is LIVE, and the freshly
  // seeded area still simulates (its suffixed flag is unwritten, which is the
  // runtime's dry-run-TRUE boot default). The Main-flag-only banner used to
  // stay silent here — an "everything is live" claim the Limits page disproved.
  await page.addInitScript(() => {
    const stubWindow = window as Window & {
      __PELS_HOMEY_STUB__?: { settings?: Record<string, unknown> };
    };
    const existing = stubWindow.__PELS_HOMEY_STUB__ ?? {};
    stubWindow.__PELS_HOMEY_STUB__ = {
      ...existing,
      settings: { ...(existing.settings ?? {}), capacity_dry_run: false },
    };
  });
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await seedRentalArea(page);

  const banner = page.locator('#dry-run-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(
    'PELS is only simulating “Rental unit”. Turn on control under Limits & safety.',
  );
  await expect(banner).toHaveAttribute('data-home-scope', 'areas');
  // The button writes MAIN's flag, which is already off — it hides, and the
  // text names the page that holds the area's own control.
  await expect(page.locator('#simulation-disable-button')).toHaveJSProperty('hidden', true);

  // The Settings hub chip renders the aggregate split, not Main's bare flag.
  await page.getByRole('tab', { name: 'Settings' }).click();
  const chip = page.locator('#settings-nav-chip-simulation');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText('Partly on');

  // Following the chip into Simulation mode must NOT present an all-live
  // screen: the page's own switch is Main's — off in this posture — so the
  // area-naming banner is the only truthful pointer to the active control
  // and stays visible here (only the Main-remedy banner variants suppress).
  await page.locator('.settings-nav-card[data-settings-target="simulation"]').click();
  await expect(page.locator('#simulation-panel')).toBeVisible();
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(
    'PELS is only simulating “Rental unit”. Turn on control under Limits & safety.',
  );

  // Turning on control (the suffixed `capacity_dry_run:<id>` write) reaches
  // the banner and chip through the realtime settings.set stream.
  await openLimitsPanel(page);
  await pickHomeScope(page, AREA_ID);
  await page.locator('#home-limits-simulation-switch').click();
  await expect.poll(() => readStubSetting(page, `capacity_dry_run:${AREA_ID}`)).toBe(false);
  await expect(banner).toBeHidden();
  await expect(chip).toHaveJSProperty('hidden', true);
});

test('a held pre-GA meter area cannot claim active control or stale live power', async ({ page }) => {
  await installRentalMeterDeviceList(page);
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await seedHeldRentalArea(page);
  await seedStubSetting(page, `capacity_dry_run:${AREA_ID}`, false);
  await seedStubSetting(page, `pels_status:${AREA_ID}`, {
    controlledKw: 2.5,
    uncontrolledKw: 1.5,
    powerKnown: true,
    hasLivePowerSample: true,
    devicesOff: 0,
    limitReason: 'none',
  });
  await openLimitsPanel(page);
  await pickHomeScope(page, AREA_ID);

  const control = page.locator('#home-limits-simulation-switch');
  // Material's custom element owns disabled semantics inside its shadow root;
  // pin the reflected property/attribute instead of native-form detection.
  await expect(control).toHaveAttribute('disabled', '');
  await expect(control).toHaveJSProperty('selected', false);
  await expect(page.locator('#home-limits-status-chip')).toHaveText('Not active');
  await expect(page.locator('#home-limits-status-power')).toHaveText('—');
  await expect(page.locator('#home-limits-inactive-notice'))
    .toContainText('open Multiple meters and save this area');
});

test('a device pin overrides zone membership in a scoped devices read', async ({ page }) => {
  // Pins the stub seam the scope-selector surface consumes: a scoped
  // `/ui_devices?homeId=` read must honor `device_home_assignments` with the
  // producer's precedence (`resolveDeviceHome`, lib/home/membership.ts) — a
  // pin to an existing home beats the zone rule, a pin to 'main' opts a
  // device out of a surrounding area, and a dangling pin falls back to the
  // zone rule. No panel drives this read yet, so the spec speaks the same
  // transport the client's `homeScopedApiUri` composes.
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await seedRentalArea(page);

  const readScopedDeviceIds = (): Promise<string[]> => page.evaluate(async (areaId) => {
    const { Homey } = window as unknown as {
      Homey: {
        api: (
          method: string,
          uri: string,
          cb: (err: Error | null, result?: { devices?: Array<{ id: string }> }) => void,
        ) => void;
      };
    };
    return new Promise<string[]>((resolve, reject) => {
      Homey.api('GET', `/ui_devices?homeId=${areaId}`, (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve((result?.devices ?? []).map((device) => device.id));
      });
    });
  }, AREA_ID);

  // Zone rule alone: the rental meter is the area's only in-subtree device.
  expect(await readScopedDeviceIds()).toEqual(['dev_rental_meter']);

  // The water heater (Utility room, outside the rental subtree) is pinned INTO
  // the area; the rental meter is pinned OUT to the Main home despite its
  // in-subtree zone; the heat pump's pin dangles (no such area) and falls back
  // to its zone rule → main, so it must not leak into the area.
  await seedStubSetting(page, 'device_home_assignments', {
    dev_waterheater: AREA_ID,
    dev_rental_meter: 'main',
    dev_heatpump: 'h_99999999',
  });

  expect(await readScopedDeviceIds()).toEqual(['dev_waterheater']);
});

test('a scoped power read gates the area solar flag on the power source', async ({ page }) => {
  // Pins the other half of the scoped-read stub seam against its producer
  // (`powerPayloadForHome`, setup/settingsUiApi.ts): the ui_power solar flag
  // reports false for a SUB-HOME regardless of its members: a sub-home bundle is
  // built without the PV taps, so its generation buckets can never fill and the
  // Usage Solar card must not promise data. An ungated stub would let a scoped
  // Usage spec render and validate a card production hides. (The gate used to
  // read the power source, on the since-retired premise that the flow boundary
  // rejects negative watts.)
  await gotoApp(page);
  await seedRentalMeterSnapshot(page);
  await seedRentalArea(page);
  await page.evaluate(() => {
    const stub = (window as unknown as {
      Homey: { __stub: { getSetting: (k: string) => unknown; setSetting: (k: string, v: unknown) => void } };
    }).Homey.__stub;
    const snapshot = stub.getSetting('target_devices_snapshot') as Array<Record<string, unknown>>;
    stub.setSetting('target_devices_snapshot', [...snapshot, {
      id: 'dev_rental_pv',
      name: 'Rental solar',
      deviceClass: 'solarpanel',
      zone: 'Rental living room',
      zoneId: 'z_rental_living',
    }]);
  });

  const readScopedSolarFlag = (): Promise<boolean | undefined> => page.evaluate(async (areaId) => {
    const { Homey } = window as unknown as {
      Homey: {
        api: (
          method: string,
          uri: string,
          cb: (err: Error | null, result?: { hasManagedSolarDevice?: boolean }) => void,
        ) => void;
      };
    };
    return new Promise<boolean | undefined>((resolve, reject) => {
      Homey.api('GET', `/ui_power?homeId=${areaId}`, (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(result?.hasManagedSolarDevice);
      });
    });
  }, AREA_ID);

  // `gotoApp` seeds the homey_energy source these fixtures model.
  expect(await readScopedSolarFlag()).toBe(true);

  await seedStubSetting(page, 'power_source', 'flow');
  expect(await readScopedSolarFlag()).toBe(false);
});
