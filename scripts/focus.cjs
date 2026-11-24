// Click-to-focus check. Usage: node scripts/focus.cjs <url> <outPrefix>
(async () => {
const { chromium } = require('playwright');
const [url, prefix] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 800 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__stitchResult, null, { timeout: 240000 });
await page.evaluate(() => window.__scene.setProgress(1));
await page.evaluate(() => document.getElementById('hide-ui').click());
await page.waitForTimeout(2500);
await page.screenshot({ path: `${prefix}_default.png`, timeout: 240000 });
await page.mouse.click(400, 120);   // far cloth
await page.waitForTimeout(3000);
await page.screenshot({ path: `${prefix}_far.png`, timeout: 240000 });
await page.mouse.click(150, 760);   // near cloth
await page.waitForTimeout(3000);
await page.screenshot({ path: `${prefix}_near.png`, timeout: 240000 });
console.log(await page.evaluate(() => window.__scene.focusDepth));
await browser.close();
})();
