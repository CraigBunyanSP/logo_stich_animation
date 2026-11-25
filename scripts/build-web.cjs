// Build a self-contained web folder with no import map: three.js and the addons it
// needs are copied in, and every bare `three` / `three/addons/...` import is rewritten
// to a relative path. Firefox only honours an import map that comes before any other
// module on the page, so hosts that inject their own scripts break bare imports there.
//
//   node scripts/build-web.cjs [outDir=dist]
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const out = path.resolve(root, process.argv[2] || 'dist');
const threeDir = path.join(root, 'node_modules/three');
fs.rmSync(out, { recursive: true, force: true });

const IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\2/g;
const queue = [], done = new Set();
// Map a specifier seen in `fromFile` (source path) to the source file it names.
function resolveSource(spec, fromFile) {
  if (spec === 'three') return path.join(threeDir, 'build/three.module.js');
  if (spec.startsWith('three/addons/')) return path.join(threeDir, 'examples/jsm', spec.slice('three/addons/'.length));
  if (spec.startsWith('.')) return path.resolve(path.dirname(fromFile), spec);
  throw new Error(`Unhandled import "${spec}" in ${fromFile}`);
}
// Where a source file lands in the output.
function outPath(src) {
  if (src.startsWith(threeDir)) {
    const rel = path.relative(threeDir, src);
    if (rel === 'build/three.module.js') return path.join(out, 'vendor/three/three.module.js');
    return path.join(out, 'vendor/three/addons', path.relative('examples/jsm', rel));
  }
  return path.join(out, path.relative(root, src));
}
function add(src) { if (!done.has(src)) { done.add(src); queue.push(src); } }
for (const f of fs.readdirSync(path.join(root, 'src'))) if (f.endsWith('.js')) add(path.join(root, 'src', f));
while (queue.length) {
  const src = queue.shift(), dest = outPath(src);
  let code = fs.readFileSync(src, 'utf8');
  code = code.replace(IMPORT, (m, pre, q, spec) => {
    const target = resolveSource(spec, src);
    add(target);
    let rel = path.relative(path.dirname(dest), outPath(target)).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    return `${pre}${q}${rel}${q}`;
  });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, code);
}
fs.cpSync(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true });
fs.copyFileSync(path.join(threeDir, 'LICENSE'), path.join(out, 'vendor/three/LICENSE'));
console.log(`Wrote ${done.size} modules to ${path.relative(root, out)}/`);

// The demo page, without its import map.
let page = fs.readFileSync(path.join(root, 'preview/motion.html'), 'utf8');
page = page.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '')
  .replaceAll("'../src/", "'./src/").replaceAll("'../assets/", "'./assets/");
if (/importmap|\.\.\//.test(page)) throw new Error('demo page still has an import map or ../ path');
fs.writeFileSync(path.join(out, 'index.html'), page);
console.log('Wrote index.html');
