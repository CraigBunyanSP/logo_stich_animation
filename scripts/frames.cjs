// Render timeline frames. Usage: node scripts/frames.cjs <url> <outPrefix> <t1,t2,...> [close]
// "close" moves the camera in on the stitch currently being pulled taut.
(async () => {
const { chromium } = require('playwright');
const [url, prefix, ts, close] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: +(process.env.W||700), height: +(process.env.H||700) }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[page]', m.text()); });
await page.goto(url);
await page.waitForFunction(() => window.__stitchResult, null, { timeout: 120000 });
for (const t of ts.split(',').map(Number)) {
  await page.evaluate(([t, close]) => {
    const s = window.__scene; s.setProgress(t);
    if (close) {
      const n = s.needleAt(t);
      const off = s.camera.position.clone().normalize().multiplyScalar(0.45);
      s.controls.target.set(n.x, 0, n.y);
      s.camera.position.set(n.x + off.x, off.y, n.y + off.z);
    }
  }, [t, !!close]);
  await page.waitForTimeout(+(process.env.WAIT||900));
  await page.screenshot({ path: `${prefix}_${t}.png` });
}
await browser.close();
})();
