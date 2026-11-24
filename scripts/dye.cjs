// Render the demo with the cloth dyed. Usage: node scripts/dye.cjs <url> <out.png> <css colour> [ui]
(async () => {
const { chromium } = require('playwright');
const [url, out, colour, ui] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: +(process.env.W||800), height: +(process.env.H||800) }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__stitchResult, null, { timeout: 240000 });
if (!ui) await page.addStyleTag({ content: '.bar{display:none!important}' });
await page.evaluate(c => { const s = window.__scene; s.setProgress(1); if (c !== 'none') s.setFabricColour(c); }, colour);
await page.waitForTimeout(+(process.env.WAIT||2500));
await page.screenshot({ path: out, timeout: 240000 });
await browser.close();
})();
