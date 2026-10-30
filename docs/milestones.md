# Milestones

The original project spec was not available when this plan was written (2026-10-30). Milestone 0
follows the real-world-geography brief exactly. M1–M5 are a proposed default; align them with the
main spec once it is added.

## M0: Geodata prep and real-location terrain and buildings ✅

- [x] One-off prep script `scripts/fetch-geodata` (dev time only, cached, accepts a local OSM file)
- [x] Centre verified with a geocoder; local metric CRS (EPSG:25832 shifted to a local origin), documented in `docs/geodata.md`
- [x] OSM via Overpass: buildings, roads, paths, land use, trees, parking, bike parking, benches, entrances, bus stops, H-Bahn
- [x] Geobasis NRW: LoD2 roofs, DGM1 terrain, DOP orthophoto (dl-de/zero-2-0)
- [x] Baked static data in `public/data/` (about 3.4 MB); the app makes zero external requests
- [x] Terrain from the DGM with an aerial texture, plus a procedural map ground as an alternative
- [x] Buildings: real footprints; LoD2 shapes for non-FH buildings; OSM extrusion fallback
- [x] FH buildings (EFS 38 ×3, 40, 42, 44, kostBar): detailed facades, enterable, real floor count
- [x] Generated interiors constrained to each real footprint; entrances at real OSM positions
- [x] Aerial orbit camera limited to the campus, smooth fly-to for buildings and rooms, compass with north reset
- [x] Labels for FH, TU, food, S-Bahn, H-Bahn and bus stops; edge pointers for landmarks outside the model
- [x] Footer attribution: "© OpenStreetMap contributors · Geobasis NRW"

Known limits:
- Room layouts are generated, not real floor plans.
- FH facade colours are approximate.
- OSM `building:part` is ignored.
- The H-Bahn track height is a fixed 10 m.

## M1: Real FH floor plans (proposed)

- Import real floor plans (CAD/PDF from FH facility management, if available) as per-building
  overrides of `interiors.json`; keep the generator as the fallback
- Real room numbers and names, lecture halls, accessibility features (lifts, ramps)
- Basement levels (`building:levels:underground`)

## M2: Wayfinding (proposed)

- Navigation graph from paths (OSM) plus corridors and stairs (interiors)
- Route from an entrance, bus stop or S-Bahn to a room, with an animated route line

## M3: Ground-level walk mode (proposed)

- First-person walking on the terrain with collision against building footprints
- Smooth switch between the aerial and pedestrian views

## M4: WebXR / VR (proposed)

- `renderer.xr` with teleport locomotion, using the M3 collision data
- Tabletop VR mode: the aerial model on a virtual table

## M5: Polish and performance (proposed)

- LOD for trees and labels, compressed textures (KTX2), lighting by time of day
- Accessibility pass (keyboard navigation of the 3D view, screen-reader room list)
