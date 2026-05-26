import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });

for (const variant of ['light', 'dark']) {
  const page = await context.newPage();
  await page.goto(`file://${path.join(here, `preview-${variant}.html`)}`);
  await page.screenshot({
    path: path.join(here, '..', `preview-${variant}.png`),
    type: 'png',
    omitBackground: true,
    clip: { x: 0, y: 0, width: 1024, height: 1024 },
  });
  await page.close();
}

await context.close();
await browser.close();
console.log('Wrote preview-light.png and preview-dark.png (1024×1024, transparent)');
