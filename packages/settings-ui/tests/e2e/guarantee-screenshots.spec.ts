import path from 'node:path';
import { expect, renderTest as test, captureOutputDir, injectHomeyHostCss, loadSpaceGrotesk } from './fixtures/test';

test('guarantee review at narrow widths in both themes', async ({ browser, baseURL }) => {
  for (const width of [320, 480]) {
    for (const dark of [false, true]) {
      const context = await browser.newContext({
        baseURL, viewport: { width, height: 1200 }, isMobile: dark, hasTouch: dark,
      });
      try {
        const page = await context.newPage();
        await injectHomeyHostCss(page);
        await page.goto('/?page=deadline-plan&deviceId=dev_connected300');
        await loadSpaceGrotesk(page);
        const card = page.locator('.plan-inputs');
        await expect(card).toContainText('Guaranteed power');
        await expect(card).toContainText('Priority 5');
        const learning = card.locator('details');
        await expect(learning).not.toHaveAttribute('open');
        const output = captureOutputDir('pels-guarantee-implementation');
        await card.screenshot({ path: path.join(output, `estimate-${width}-${dark ? 'dark' : 'light'}.png`) });
        await page.locator('.smart-task-actions').screenshot({
          path: path.join(output, `actions-${width}-${dark ? 'dark' : 'light'}.png`),
        });
        await learning.locator('summary').click();
        await expect(learning).toHaveAttribute('open');
        await page.getByRole('button', { name: 'Review power guarantee', exact: true }).click();
        const editor = page.locator('.smart-task-edit');
        await expect(editor.locator('.smart-task-edit__permissions')).toHaveAttribute('open');
        await expect(editor).toContainText('Their tasks may take longer');
        await expect(editor.getByRole('button', { name: 'Save changes' })).toBeDisabled();
        await editor.screenshot({ path: path.join(output, `review-${width}-${dark ? 'dark' : 'light'}.png`) });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await editor.getByRole('button', { name: 'Discard' }).click();
        await expect(editor).toHaveCount(0);
        await expect(learning).toHaveAttribute('open');
      } finally {
        await context.close();
      }
    }
  }
});
