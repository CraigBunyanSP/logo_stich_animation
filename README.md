# Stitch logo animation

A code-based embroidery simulation that "stitches" any SVG logo into life in the browser, built for interactive use on websites (scroll, hover, autoplay) rather than as a rendered video.

## Status

1. **Stitch engine** (`src/stitch-engine.js`) – done. Turns any SVG into ordered satin / tatami stitches.
2. WebGL look development (three options matched to the chosen art-direction still) – next.
3. Motion and interaction (loops springing up and pulling taut, canvas pucker, scroll / hover binding).
4. Drop-in SVG tool and embeddable web component.

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

## Preview

```sh
npm run serve
# open http://localhost:8765/preview/engine.html  (drag the progress slider, or load another SVG)
```

`assets/sp-roundel.svg` is the Seymourpowell roundel, traced from the brand asset preview.
