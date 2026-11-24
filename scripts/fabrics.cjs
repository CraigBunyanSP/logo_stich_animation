// Render each cloth option, wide and close. Usage: node scripts/fabrics.cjs <url> <outPrefix> <key1,key2,...> [look]
(async () => {
const { chromium } = require('playwright');
const [url, prefix, keys, look] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: +(process.env.W||800), height: +(process.env.H||800) }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[page]', m.text()); });
await page.goto(url);
await page.waitForFunction(() => window.__stitchResult, null, { timeout: 240000 });
await page.addStyleTag({ content: '.bar{display:none!important}' });
for (const key of keys.split(',')) {
  for (const close of [false, true]) {
    await page.evaluate(async ([key, close, look]) => {
      const s = window.__scene;
      if (look) s.applyLook((await import('/src/renderer.js')).LOOKS[look]);
      await s.setFabric(key); s.setProgress(1);
      if (!s.__home) s.__home = { p: s.camera.position.clone(), t: s.controls.target.clone() };
      s.camera.position.copy(s.__home.p); s.controls.target.copy(s.__home.t);
      if (close) {
        const n = s.needleAt(0.5);
        const off = s.camera.position.clone().normalize().multiplyScalar(0.42);
        s.controls.target.set(n.x, 0, n.y);
        s.camera.position.set(n.x + off.x, off.y, n.y + off.z);
      }
    }, [key, close, look || '']);
    await page.waitForTimeout(+(process.env.WAIT||2500));
    await page.screenshot({ path: `${prefix}_${key}${close ? '_close' : ''}.png`, timeout: 240000 });
    console.log('shot', key, close);
  }
}
await browser.close();
})();
