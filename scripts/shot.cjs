(async () => {
// Screenshot a preview page. Usage: node scripts/shot.mjs <url> <out.png> [waitForGlobal]
const { chromium } = require('playwright');

const [url, out, waitFor = '__stitchResult'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: +(process.env.W||760), height: +(process.env.H||900) }, deviceScaleFactor: 1 });
page.on('console', m => console.log('[page]', m.type(), m.text()));
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForFunction(g => window[g], waitFor, { timeout: 120000 });
await page.waitForTimeout(+(process.env.WAIT||500));
const info = await page.evaluate(() => document.getElementById('stats')?.textContent);
console.log(info);
await page.screenshot({ path: out });
await browser.close();
})();
