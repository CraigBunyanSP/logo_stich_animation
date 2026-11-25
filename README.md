# Stitch logo animation

A code-based embroidery simulation that "stitches" any SVG logo into life in the browser, built for interactive use on websites (scroll, hover, autoplay) rather than as a rendered video.

**Live demo:** https://craigbunyansp.github.io/logo_stich_animation/ (rebuilt from `main` on every push)

## Status

1. **Stitch engine** (`src/stitch-engine.js`) – done. Turns any SVG into ordered satin / tatami stitches.
2. **Look development** (`src/renderer.js`, `src/textures.js`) – done. Golden window (default) and Studio daylight; scanned CC0 cloth (see `assets/fabric/CREDITS.md`) or the procedural weave.
3. **Motion** (`src/motion.js`, `src/accumulate-pass.js`) – done. Spring & settle: each stitch springs up as a loose loop and snaps taut in stitch order; cloth tugs and puckers; motion blur and supersampling. Drive with autoplay, scroll or hover.
4. **Drop-in SVG** – done in the demo (file picker, drag and drop; SVG, PNG, JPEG). Embeddable web component still to do.

## Stitch engine

```js
import { svgToStitches } from './src/stitch-engine.js';
const result = await svgToStitches(svgText);
// result.layers[] -> { colour, regions[] -> { stitches[] -> { a:[x,y], b:[x,y], t } } }
```

- Coordinates are normalised to `[-0.5, 0.5]`, y up, centred.
- `t` is each stitch's playback position (0..1) for driving the animation.
- Colour layers come from the SVG's fills; anti-aliased edge colours are merged.
- Stroke-like shapes get satin stitch across the stroke (via distance transform + skeleton); wide areas fall back to tatami fill.

## Build for the web

```sh
npm install
npm run build   # writes dist/: the demo page plus three.js, with every import rewritten to a relative path
```

`dist/` needs no import map, so it works in Firefox even on pages that load their own scripts first. GitHub Actions (`.github/workflows/pages.yml`) builds it and publishes it to GitHub Pages.

## Preview

```sh
npm install
npm run serve
# http://localhost:8765/preview/engine.html  2D stitch preview (drag progress, load another SVG)
# http://localhost:8765/preview/look.html     3D look preview (?look=studio|window|graphic)
```

`assets/sp-roundel.svg` is the Seymourpowell roundel, traced from the brand asset preview.
