# Geodata: sources, pipeline and coordinate system

The app is a small "Google Earth"-style model of the FH Dortmund campus at Emil-Figge-Straße.
Everything geographic is real data, baked once at dev time by `scripts/fetch-geodata/` into
`public/data/`. The running app loads only those files from its own origin and makes **no
requests to any other host**.

## Area and centre

| | |
|---|---|
| Centre | 51.49400 N, 7.42020 E: the centroid of the FH buildings EFS 38–44 and kostBar |
| Verified | 2026-10-30 with Nominatim (OSM ways 130871490, 24580642, 24551042, 666943113, 95804177). The script repeats the check on every online run and warns if the centre drifts more than 75 m. |
| Camera bounds | ±300 m (600 × 600 m) |
| Baked area | ±350 m (300 m + 50 m margin) |

The original brief gave 51.4925 N, 7.4142 E. That point is the TU Mensa / H-Bahn "Campus Nord",
about 420 m west of the FH buildings, so the model is centred on the geocoded FH position instead.
Landmarks outside the baked area (Mensa, TU Campus Nord, other H-Bahn and S-Bahn stops) appear as
pointers on the edge of the model, showing their distance.

## Coordinate system

1. WGS84 lon/lat is projected to **ETRS89 / UTM 32N (EPSG:25832)**. This is the native CRS of all
   Geobasis NRW products, so LoD2, DGM and DOP need no reprojection.
2. The centre is projected and rounded to whole metres to give the **local origin**:
   E 390330, N 5705945 (see `public/data/meta.json → origin`).
3. Local map coordinates: `x = E − 390330`, `y = N − 5705945` (metres, x east, y north).
4. Elevation: metres above `baseElevation`, the DGM height at the origin (112.93 m NHN, DHHN2016).
5. Three.js scene: `X = x`, `Y = elevation`, `Z = −y` (north is −Z).

All baked JSON uses local `[x, y]` coordinates in metres, so these files are GeoJSON-shaped but not
WGS84 GeoJSON.

## Sources

| Data | Source | Licence | Used for |
|---|---|---|---|
| Buildings, roads, paths, land use, trees, benches, bike parking, bus stops, entrances, stations, H-Bahn | OpenStreetMap via Overpass API (fallback: OSM API 0.6 `/map`) | ODbL 1.0, attribution "© OpenStreetMap contributors" | footprints, map layers, labels |
| LoD2 3D building models (CityGML) | Geobasis NRW, `opengeodata.nrw.de/produkte/geobasis/3dg/lod2_gml` | Datenlizenz Deutschland – Zero 2.0 | real roof shapes for all non-FH buildings, measured heights |
| DGM1 terrain (1 m GeoTIFF) | Geobasis NRW, `…/hm/dgm1_tiff` | dl-de/zero-2-0 | ground elevation, resampled to a 2 m grid |
| DOP orthophoto | Geobasis NRW WMS `wms.nrw.de/geobasis/wms_nw_dop`, layer `nw_dop_rgb` | dl-de/zero-2-0 | ground texture, 4096 px WebP (~0.17 m/px) |

dl-de/zero-2-0 does not require attribution, but the footer credits "Geobasis NRW" anyway. Google
Maps/Earth imagery, tiles and APIs are not used anywhere.

## Running the prep script

```bash
npm run fetch-geodata
```

Downloads are cached in `scripts/fetch-geodata/.cache/` (git-ignored, about 70 MB). Options:

| Flag | Effect |
|---|---|
| `--osm-file <path>` | Use a local OSM file instead of Overpass: raw OSM JSON, `.osm` XML or GeoJSON (e.g. an Overpass Turbo export) |
| `--offline` | Use cached downloads only |
| `--refresh` | Ignore the cache and download again |
| `--no-nrw` | Skip Geobasis NRW: flat ground, OSM extrusions only, procedural map ground |
| `--no-ortho` | Skip only the aerial photo |
| `--ortho-size N` | Aerial image size in pixels (default 4096; the WMS allows up to 5000) |

If Overpass cannot be reached, the script falls back to the OSM API. If that also fails, it prints
an Overpass Turbo query to export by hand and pass with `--osm-file`.

## Baked files (`public/data/`, about 3.4 MB)

| File | Contents |
|---|---|
| `meta.json` | origin, CRS, bounds, base elevation, terrain/ortho descriptors, sources, attribution |
| `buildings.json` | every OSM building: footprint, base, height and its source, floors and their source, entrances, render mode; plus the LoD2 mesh layout and the LoD2→OSM match table |
| `lod2.bin` | merged LoD2 wall and roof meshes (Float32 positions in scene axes, Uint32 indices, Uint16 building id per vertex) |
| `terrain.bin` | 351 × 351 Uint16 heights, 2 m cells, row 0 = north edge; decode with `meta.terrain` |
| `ortho.webp` | aerial photo covering exactly the baked square |
| `map.json` | roads/paths with widths, land-use polygons by class, H-Bahn ways, point features |
| `labels.json` | landmark labels (FH, TU, food, S-Bahn, H-Bahn, bus) and edge pointers for distant landmarks |
| `interiors.json` | generated floor plans for the enterable FH buildings |

## Rules applied while baking

**Building height:** the OSM `height` tag, else `building:levels × 3.2 m` (+ `roof:height`), else the
LoD2 measured height, else 9.6 m. `heightSource` records which one was used.

**Floors:** `building:levels`, else derived from the height (marked `derived from …`), else 3.

**Render mode:** FH buildings are `detailed` (procedural facade, enterable). Other buildings with a
LoD2 match are `lod2` (real roof shape). The rest are `extrude` (plain OSM extrusion).

**FH buildings:** EFS 38 (FH-Plus 1–3), EFS 40, EFS 42, EFS 44 and kostBar. They are listed in
`config.mjs → ENTERABLE`. The script reports any other building with an FH address that is not in
that list.

**Ground floor level:** for FH buildings, the median terrain height at the entrances, so on sloping
ground the ground floor sits at door level. A plinth reaches down to the lowest terrain point.

**Entrances:** OSM `entrance=*` / `door=*` nodes within 1.5 m of a footprint. An FH building with
none gets one at the middle of the wall facing the nearest path, marked `assumed: true`. Assumed
entrances show orange in the app. With the current OSM data, every FH building has mapped
entrances.

**Interiors** (`interiors.mjs`): the footprint's minimum oriented bounding box is split into bands
of *rooms | 2.4 m corridor | rooms*, about 6.5 m deep. Cross corridors with stair cores are added
every ~36 m and at long-side entrances, plus a connector corridor from each entrance. Room cells are
about 4.8 m wide and are intersected with the real footprint polygon, minus the corridors and
stairs, so every room lies inside the real outline. Room types are assigned by area. The layout is
**generated, not the real floor plan**, and the data and UI both say so.

**Trees:** mapped `natural=tree` nodes (height and crown from tags where present), trees every 8 m
along `tree_row`s, and a deterministic scatter inside forest/scrub polygons. The scattered trees are
flagged as generated.
