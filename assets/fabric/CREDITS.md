# Cloth scans (all CC0, public domain)

| Folder | Source | Notes |
| --- | --- | --- |
| `canvas` | ambientCG Fabric032, https://ambientcg.com/view?id=Fabric032 | cotton canvas plain weave |
| `linen` | ambientCG Fabric036, https://ambientcg.com/view?id=Fabric036 | linen weave, has AO |
| `natural` | ambientCG Fabric001, https://ambientcg.com/view?id=Fabric001 | soft, irregular natural linen |

Colour maps were converted to neutral greyscale (mean ~232) so `setFabricColour()` and each look can dye the cloth.
Normals are OpenGL convention. To add your own set (e.g. exported from Substance), drop
`color.jpg`, `normal.jpg`, `roughness.jpg` and optionally `ao.jpg` into a new folder and add an entry to `FABRICS` in `src/renderer.js`.
