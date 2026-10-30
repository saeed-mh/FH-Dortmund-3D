#!/usr/bin/env node
// One-off geodata prep: downloads real data for the EFS campus and bakes it into public/data/.
// Run at dev time only (npm run fetch-geodata); the app never touches the network.
//
//   node scripts/fetch-geodata                       download everything (cached in .cache/)
//   node scripts/fetch-geodata --osm-file export.json  use a local OSM file instead of Overpass
//                                                    (Overpass Turbo export: raw OSM JSON, .osm XML or GeoJSON)
//   --no-nrw      skip Geobasis NRW (flat terrain, OSM-only buildings, procedural ground)
//   --no-ortho    skip the aerial photo only
//   --ortho-size N  aerial image size in pixels (default 4096)
//   --offline     use cached downloads only
//   --refresh     ignore the cache and download again

import fs from 'node:fs';
import path from 'node:path';
import pc from 'polygon-clipping';
import {
  CENTRE, CRS, DEFAULT_HEIGHT, DEFAULT_LEVELS, ENTERABLE, FH_HOUSENUMBERS, FH_STREET, HALF_SIZE, LEVEL_HEIGHT, MARGIN,
  NOMINATIM, NRW, ORTHO_SIZE, OUT_DIR,
} from './config.mjs';
import { generateInterior } from './interiors.mjs';
import { bakeLod2Mesh, bakeOrtho, bakeTerrain, loadLod2 } from './nrw.mjs';
import { downloadContext, downloadOsm, normalisePolygon, readOsmFile, toFeatures } from './osm.mjs';
import {
  EXTENT, ORIGIN, cachedFetch, distToRing, distToSegment, inExtent, localToLonLat, lonLatToLocal, log, opts, pointInPolygon, polylineLength,
  ringArea, ringCentroid, rng, round, roundRing, warn,
} from './util.mjs';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const value = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
opts.offline = flag('--offline');
opts.refresh = flag('--refresh');
const useNrw = !flag('--no-nrw');
const useOrtho = useNrw && !flag('--no-ortho');
const orthoSize = Number(value('--ortho-size') ?? ORTHO_SIZE);
const osmFile = value('--osm-file');

const sources = [];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`centre ${CENTRE.lat}, ${CENTRE.lon} -> ${CRS} origin E ${ORIGIN.e} N ${ORIGIN.n}; area ±${HALF_SIZE} m (+${MARGIN} m margin)`);
  if (!opts.offline) await verifyCentre();

  // ---------------------------------------------------------------- OSM
  let input;
  if (osmFile) input = readOsmFile(path.resolve(osmFile));
  else {
    try {
      input = await downloadOsm();
    } catch (err) {
      console.error(`\nCould not download OpenStreetMap data: ${err.message}\n` +
        'Export the area from https://overpass-turbo.eu (Export -> raw OSM data) with this query and run\n' +
        '  npm run fetch-geodata -- --osm-file path/to/export.json\n\n' + overpassTurboQuery());
      process.exit(1);
    }
  }
  sources.push({ name: 'OpenStreetMap', via: input.source, licence: 'ODbL 1.0', attribution: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' });
  const features = toFeatures(input);
  log(`OSM: ${features.length} tagged features (${input.source})`);

  // ---------------------------------------------------------------- terrain
  let terrain = null;
  let heightAt = () => 0;
  let baseElevation = null;
  if (useNrw) {
    try {
      terrain = await bakeTerrain();
      heightAt = terrain.heightAt;
      baseElevation = terrain.baseElevation;
      fs.writeFileSync(path.join(OUT_DIR, 'terrain.bin'), terrain.bin);
      sources.push({ name: 'Geobasis NRW – DGM1 (digital terrain model, 1 m)', via: NRW.dgm1Index, licence: NRW.licence, attribution: 'Geobasis NRW' });
    } catch (err) {
      warn(`terrain unavailable, using flat ground: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------- buildings
  const buildings = buildBuildings(features, heightAt);
  let lod2 = null;
  if (useNrw && baseElevation != null) {
    try {
      lod2 = await attachLod2(buildings, baseElevation);
      sources.push({ name: 'Geobasis NRW – 3D-Gebäudemodell LoD2', via: NRW.lod2Index, licence: NRW.licence, attribution: 'Geobasis NRW' });
    } catch (err) {
      warn(`LoD2 unavailable, extruding OSM footprints: ${err.message}`);
    }
  }
  finishHeights(buildings);
  const map = buildMap(features, heightAt);
  attachEntrances(buildings, features, map.roads);
  levelFhBases(buildings, heightAt);

  // ---------------------------------------------------------------- interiors
  const interiors = buildings.filter((b) => b.enterable).map((b) => generateInterior(b, b.entrances));
  for (const i of interiors) log(`interior ${i.key}: ${i.floors} floors, ${i.rooms.length / i.floors} rooms/floor, ${i.entrances.length} entrances (${i.entrances.filter((e) => e.assumed).length} assumed)`);

  // ---------------------------------------------------------------- labels
  const labels = buildLabels(buildings, features);
  labels.offArea = await buildOffAreaLabels();

  // ---------------------------------------------------------------- aerial
  let ortho = null;
  if (useOrtho) {
    try {
      ortho = await bakeOrtho(orthoSize);
      fs.writeFileSync(path.join(OUT_DIR, 'ortho.webp'), ortho.webp);
      sources.push({ name: 'Geobasis NRW – Digitale Orthophotos (DOP)', via: ortho.meta.source, licence: NRW.licence, attribution: 'Geobasis NRW' });
    } catch (err) {
      warn(`orthophoto unavailable, ground will be procedural: ${err.message}`);
    }
  }
  if (!ortho) fs.rmSync(path.join(OUT_DIR, 'ortho.webp'), { force: true });
  if (!terrain) fs.rmSync(path.join(OUT_DIR, 'terrain.bin'), { force: true });

  // ---------------------------------------------------------------- write
  const write = (name, obj) => fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(obj));
  if (lod2) fs.writeFileSync(path.join(OUT_DIR, 'lod2.bin'), lod2.bin);
  else fs.rmSync(path.join(OUT_DIR, 'lod2.bin'), { force: true });
  write('buildings.json', {
    buildings,
    lod2: lod2 && { file: 'lod2.bin', layout: lod2.layout, buildings: lod2.index },
  });
  write('map.json', map);
  write('labels.json', labels);
  write('interiors.json', interiors);
  const attribution = ['© OpenStreetMap contributors', ...(sources.some((s) => s.attribution === 'Geobasis NRW') ? ['Geobasis NRW (dl-de/zero-2-0)'] : [])];
  write('meta.json', {
    generatedAt: new Date().toISOString(),
    centre: CENTRE,
    crs: CRS,
    origin: ORIGIN,
    axes: 'local x = easting - origin.e, local y = northing - origin.n (metres); elevations in metres above baseElevation. Three.js scene: X = x, Y = elevation, Z = -y',
    baseElevation,
    baseElevationDatum: baseElevation == null ? null : 'DHHN2016 (m NHN)',
    bounds: { halfSize: HALF_SIZE, margin: MARGIN, extent: EXTENT },
    terrain: terrain?.meta ?? null,
    ortho: ortho?.meta ?? null,
    lod2: lod2 ? { file: 'lod2.bin', buildings: lod2.index.length } : null,
    attribution,
    sources,
  });
  report();
}

// ================================================================== centre check

async function verifyCentre() {
  try {
    const ids = ENTERABLE.map((b) => b.osm.replace('way/', 'W').replace('node/', 'N').replace('relation/', 'R')).join(',');
    const buf = await cachedFetch('nominatim-verify.json', `${NOMINATIM}/lookup?osm_ids=${ids}&format=json`, { accept: /json/ });
    const found = JSON.parse(buf.toString('utf8'));
    if (!found.length) return warn('geocoder returned nothing for the FH buildings');
    const pts = found.map((f) => lonLatToLocal(+f.lon, +f.lat));
    const c = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    const d = Math.hypot(c[0], c[1]);
    log(`geocoder check: FH buildings' centroid is ${d.toFixed(0)} m from the configured centre`);
    if (d > 75) warn(`configured CENTRE is ${d.toFixed(0)} m off the FH buildings – update config.mjs`);
  } catch (err) {
    warn(`centre check skipped: ${err.message}`);
  }
}

// ================================================================== buildings

const num = (v) => {
  if (v == null) return null;
  const m = String(v).replace(',', '.').match(/^\s*(-?\d+(?:\.\d+)?)\s*(m|meter|metres)?\s*$/i);
  return m ? Number(m[1]) : null;
};

function buildBuildings(features, heightAt) {
  const enterableById = new Map(ENTERABLE.map((e) => [e.osm, e]));
  const out = [];
  for (const f of features) {
    if (f.kind !== 'polygon' || !f.tags.building || f.tags.building === 'no') continue;
    const footprint = normalisePolygon(f.coords).map((p) => p.map((r) => roundRing(r)));
    if (!footprint.length) continue;
    const main = footprint.reduce((a, p) => (Math.abs(ringArea(p[0])) > Math.abs(ringArea(a[0])) ? p : a));
    const centroid = ringCentroid(main[0]);
    if (!inExtent(centroid)) continue;
    const t = f.tags;
    const cfg = enterableById.get(f.osm);
    const addr = t['addr:street'] ? `${t['addr:street']} ${t['addr:housenumber'] ?? ''}`.trim() : null;
    if (!cfg && t['addr:street'] === FH_STREET && FH_HOUSENUMBERS.includes(t['addr:housenumber'])) {
      log(`note: ${f.osm} (${t.name ?? addr}) has an FH address but is not in ENTERABLE`);
    }
    const ground = footprint.flatMap((p) => p[0]);
    out.push({
      id: f.osm,
      name: t.name ?? null,
      address: addr,
      type: t.building,
      operator: t.operator ?? null,
      enterable: Boolean(cfg),
      key: cfg?.key ?? null,
      short: cfg?.short ?? null,
      label: cfg?.label ?? null,
      footprint,
      area: round(footprint.reduce((a, p) => a + Math.abs(ringArea(p[0])) - p.slice(1).reduce((h, r) => h + Math.abs(ringArea(r)), 0), 0), 1),
      centroid: centroid.map((v) => round(v, 2)),
      base: round(Math.min(...ground.map(([x, y]) => heightAt(x, y)), heightAt(...centroid)), 2),
      groundMin: round(Math.min(...ground.map(([x, y]) => heightAt(x, y)), heightAt(...centroid)), 2),
      tagHeight: num(t.height),
      minHeight: num(t.min_height) ?? (num(t['building:min_level']) != null ? num(t['building:min_level']) * LEVEL_HEIGHT : 0),
      tagLevels: num(t['building:levels']),
      undergroundLevels: num(t['building:levels:underground']),
      roofShape: t['roof:shape'] ?? null,
      roofHeight: num(t['roof:height']),
      entrances: [],
      lod2: [],
    });
  }
  for (const e of ENTERABLE) if (!out.some((b) => b.id === e.osm)) warn(`enterable building ${e.osm} (${e.short}) not found in OSM data`);
  log(`buildings: ${out.length} (${out.filter((b) => b.enterable).length} enterable)`);
  return out;
}

async function attachLod2(buildings, baseElevation) {
  const lod2 = await loadLod2(baseElevation);
  // match each LoD2 building to the OSM footprint containing its ground centroid
  for (const [i, l] of lod2.entries()) {
    let match = buildings.find((b) => b.footprint.some((p) => pointInPolygon(l.centre, p)));
    if (!match) {
      let best = 5;
      for (const b of buildings) {
        const d = Math.min(...b.footprint.map((p) => distToRing(l.centre, p[0])));
        if (d < best) { best = d; match = b; }
      }
    }
    l.osm = match?.id ?? null;
    if (match) match.lod2.push(i);
  }
  // FH buildings get detailed procedural models; everything else uses the real LoD2 shape
  const keep = lod2.filter((l) => !buildings.find((b) => b.id === l.osm)?.enterable);
  const index = keep.map((l) => ({ gmlId: l.gmlId, osm: l.osm, height: round(l.topZ - l.groundZ, 2), groundZ: l.groundZ, topZ: l.topZ, roofType: l.roofType }));
  for (const b of buildings) {
    const mine = b.lod2.map((i) => lod2[i]);
    b.lod2Height = mine.length ? round(Math.max(...mine.map((l) => l.topZ)) - Math.min(...mine.map((l) => l.groundZ)), 2) : null;
    b.lod2Ground = mine.length ? round(Math.min(...mine.map((l) => l.groundZ)), 2) : null;
    b.lod2 = mine.filter((l) => keep.includes(l)).map((l) => keep.indexOf(l));
  }
  const mesh = bakeLod2Mesh(keep);
  log(`LoD2 mesh: ${keep.length} buildings, ${(mesh.bin.length / 1e6).toFixed(2)} MB`);
  return { bin: mesh.bin, layout: mesh.layout, index };
}

function finishHeights(buildings) {
  for (const b of buildings) {
    if (b.tagHeight) { b.height = b.tagHeight; b.heightSource = 'osm:height'; }
    else if (b.tagLevels) { b.height = round(b.tagLevels * LEVEL_HEIGHT + (b.roofHeight ?? 0), 2); b.heightSource = 'osm:building:levels'; }
    else if (b.lod2Height) { b.height = b.lod2Height; b.heightSource = 'lod2:measured'; }
    else { b.height = DEFAULT_HEIGHT; b.heightSource = 'default'; }
    if (b.lod2Ground != null) b.base = b.lod2Ground;
    if (b.tagLevels) { b.levels = b.tagLevels; b.levelsSource = 'osm:building:levels'; }
    else if (b.heightSource !== 'default') { b.levels = Math.max(1, Math.round((b.height - b.minHeight) / LEVEL_HEIGHT)); b.levelsSource = `derived from ${b.heightSource}`; }
    else { b.levels = DEFAULT_LEVELS; b.levelsSource = 'default'; }
    b.floorHeight = round(Math.min(4.5, Math.max(2.8, (b.height - b.minHeight - (b.roofHeight ?? 0)) / b.levels)), 2);
    b.render = b.enterable ? 'detailed' : b.lod2.length ? 'lod2' : 'extrude';
    delete b.tagHeight; delete b.tagLevels; delete b.lod2Height; delete b.lod2Ground;
  }
}

// ================================================================== entrances

function attachEntrances(buildings, features, roads) {
  for (const f of features) {
    if (f.kind !== 'point' || !(f.tags.entrance || f.tags.door)) continue;
    const b = buildings.find((b) => b.footprint.some((p) => distToRing(f.coords, p[0]) < 1.5));
    if (!b) continue;
    b.entrances.push({
      x: round(f.coords[0], 2), y: round(f.coords[1], 2), osm: f.osm, assumed: false,
      type: f.tags.entrance ?? 'yes', ref: f.tags.ref ?? f.tags['addr:housenumber'] ?? null, wheelchair: f.tags.wheelchair ?? null,
    });
  }
  // enterable buildings without mapped entrances: the midpoint of the wall facing the nearest path
  const paths = roads.filter((r) => ['footway', 'path', 'pedestrian', 'service', 'residential', 'unclassified', 'tertiary', 'living_street', 'cycleway', 'steps'].includes(r.type));
  for (const b of buildings) {
    if (!b.enterable || b.entrances.length) continue;
    const ring = b.footprint[0][0];
    let best = null;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], c = ring[(i + 1) % ring.length];
      if (Math.hypot(c[0] - a[0], c[1] - a[1]) < 4) continue;
      const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
      let d = Infinity;
      for (const r of paths) for (let k = 1; k < r.line.length; k++) d = Math.min(d, distToSegment(mid, r.line[k - 1], r.line[k]));
      if (!best || d < best.d) best = { d, mid };
    }
    if (best) b.entrances.push({ x: round(best.mid[0], 2), y: round(best.mid[1], 2), osm: null, assumed: true, type: 'main', ref: null, wheelchair: null });
    warn(`${b.short}: no OSM entrance nodes; placed an assumed entrance facing the nearest path`);
  }
}

/**
 * FH ground floors sit at the ground level of their entrances (DGM), not at the lowest terrain
 * point under the footprint; the renderer adds a plinth for the downhill side.
 */
function levelFhBases(buildings, heightAt) {
  for (const b of buildings.filter((b) => b.enterable)) {
    const doors = b.entrances.filter((e) => !e.type || !['emergency', 'service', 'garage'].includes(e.type));
    const hs = (doors.length ? doors : b.entrances).map((e) => heightAt(e.x, e.y));
    if (!hs.length) continue;
    hs.sort((a, c) => a - c);
    b.base = round(hs[Math.floor(hs.length / 2)], 2);
  }
}

// ================================================================== map layers

const ROAD_WIDTH = {
  motorway: 10, trunk: 9, primary: 9, secondary: 8, tertiary: 7, unclassified: 5.5, residential: 5.5, living_street: 5,
  service: 4, pedestrian: 4, track: 3, cycleway: 2.2, footway: 2, path: 1.8, bridleway: 2, steps: 2, corridor: 2,
};

function areaClass(t) {
  if (t.building || t['building:part']) return null;
  if (t.natural === 'water' || t.water || t.waterway === 'riverbank' || t.landuse === 'basin' || t.landuse === 'reservoir') return 'water';
  if (t.landuse === 'forest' || t.natural === 'wood') return 'forest';
  if (t.natural === 'scrub' || t.natural === 'heath') return 'scrub';
  if (t.amenity === 'parking' || t.amenity === 'bicycle_parking' || t['area:highway'] || (t.highway && t.area === 'yes') || t.place === 'square' || t.landuse === 'railway' || t.amenity === 'marketplace') return 'paved';
  if (t.leisure === 'pitch' || t.leisure === 'track' || t.leisure === 'playground') return 'pitch';
  if (['grass', 'meadow', 'village_green', 'recreation_ground', 'flowerbed', 'allotments', 'orchard', 'cemetery'].includes(t.landuse) ||
    ['park', 'garden', 'common', 'dog_park'].includes(t.leisure) || ['grassland', 'meadow'].includes(t.natural)) return 'grass';
  if (t.landuse === 'farmland' || t.landuse === 'farmyard') return 'farmland';
  if (t.landuse === 'construction' || t.landuse === 'brownfield' || t.landuse === 'greenfield') return 'construction';
  if (['residential', 'education', 'commercial', 'retail', 'industrial'].includes(t.landuse) || ['university', 'college', 'school'].includes(t.amenity)) return 'campus';
  return null;
}

const AREA_ORDER = ['campus', 'farmland', 'construction', 'grass', 'scrub', 'forest', 'pitch', 'water', 'paved'];

function buildMap(features, heightAt) {
  const box = [[[-EXTENT, -EXTENT], [EXTENT, -EXTENT], [EXTENT, EXTENT], [-EXTENT, EXTENT]]];
  const r1 = (ring) => roundRing(ring, 1);
  const near = (line) => line.some((p) => inExtent(p, 40));

  const roads = [], areas = [], hbahn = [], treeRows = [];
  for (const f of features) {
    const t = f.tags;
    if (f.kind === 'line' && t.highway && ROAD_WIDTH[t.highway] && near(f.coords)) {
      roads.push({
        id: f.osm, type: t.highway, name: t.name ?? null, width: num(t.width) ?? ROAD_WIDTH[t.highway],
        surface: t.surface ?? null, bridge: t.bridge === 'yes', tunnel: t.tunnel === 'yes', layer: Number(t.layer ?? 0),
        line: r1(f.coords),
      });
    } else if (f.kind === 'line' && (t.railway === 'monorail' || (t.railway && /H-Bahn/i.test(t.name ?? ''))) && near(f.coords)) {
      hbahn.push({ id: f.osm, line: r1(f.coords), name: t.name ?? 'H-Bahn' });
    } else if (f.kind === 'line' && t.natural === 'tree_row' && near(f.coords)) {
      treeRows.push(f.coords);
    }
    if (f.kind === 'polygon') {
      const cls = areaClass(t);
      if (!cls) continue;
      let clipped;
      try {
        clipped = pc.intersection(normalisePolygon(f.coords), box);
      } catch {
        continue;
      }
      for (const poly of clipped) areas.push({ id: f.osm, class: cls, tags: pickTags(t), polygon: poly.map((r) => r1(r.slice(0, -1))) });
    }
  }
  areas.sort((a, b) => AREA_ORDER.indexOf(a.class) - AREA_ORDER.indexOf(b.class));

  // points
  const pts = { trees: [], benches: [], bikeParking: [], busStops: [], parking: [], stations: [], waste: [], lamps: [] };
  const centre = (f) => (f.kind === 'point' ? f.coords : f.kind === 'polygon' ? ringCentroid(f.coords[0][0]) : null);
  for (const f of features) {
    const t = f.tags;
    const c = centre(f);
    if (!c || !inExtent(c)) continue;
    const p = [round(c[0], 2), round(c[1], 2)];
    if (t.natural === 'tree' && f.kind === 'point') {
      pts.trees.push([...p, num(t.height) ?? 0, num(t.diameter_crown) ?? 0, t.leaf_type === 'needleleaved' ? 1 : 0]);
    } else if (t.amenity === 'bench' || t.leisure === 'picnic_table') {
      pts.benches.push([...p, Number(t.direction) || 0]);
    } else if (t.amenity === 'bicycle_parking') {
      pts.bikeParking.push([...p, Number(t.capacity) || 0]);
    } else if (t.highway === 'bus_stop' || (t.public_transport === 'platform' && t.bus === 'yes')) {
      pts.busStops.push({ x: p[0], y: p[1], name: t.name ?? null, osm: f.osm, shelter: t.shelter === 'yes' });
    } else if (t.amenity === 'parking') {
      pts.parking.push({ x: p[0], y: p[1], name: t.name ?? null, capacity: Number(t.capacity) || null, access: t.access ?? null });
    } else if (t.railway === 'station' || t.railway === 'halt') {
      pts.stations.push({ x: p[0], y: p[1], name: t.name ?? null, osm: f.osm, kind: t.monorail === 'yes' || t.station === 'monorail' ? 'hbahn' : 'rail' });
    } else if (t.amenity === 'waste_basket') {
      pts.waste.push(p);
    } else if (t.highway === 'street_lamp') {
      pts.lamps.push(p);
    }
  }
  // trees along mapped tree rows (every 8 m), marked as generated
  const generatedTrees = [];
  for (const line of treeRows) {
    const total = polylineLength(line);
    for (let d = 2; d < total; d += 8) {
      const q = alongLine(line, d);
      if (inExtent(q)) generatedTrees.push([round(q[0], 2), round(q[1], 2)]);
    }
  }
  // woodland: scatter trees inside forest/scrub polygons (deterministic, ~1 per 60 m², capped)
  const rand = rng(4242);
  for (const a of areas.filter((a) => a.class === 'forest' || a.class === 'scrub')) {
    const ring = a.polygon[0];
    const area = Math.abs(ringArea(ring));
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const want = Math.min(1500, Math.round(area / (a.class === 'forest' ? 60 : 120)));
    for (let k = 0, tries = 0; k < want && tries < want * 6; tries++) {
      const q = [x0 + rand() * (x1 - x0), y0 + rand() * (y1 - y0)];
      if (pointInPolygon(q, a.polygon)) { generatedTrees.push([round(q[0], 1), round(q[1], 1)]); k++; }
    }
  }
  log(`map: ${roads.length} roads/paths, ${areas.length} areas, ${hbahn.length} H-Bahn ways, ${pts.trees.length} mapped trees, ${generatedTrees.length} generated trees`);
  return { roads: roads.sort((a, b) => a.width - b.width), areas, hbahn, points: { ...pts, generatedTrees } };
}

function alongLine(line, d) {
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1], [bx, by] = line[i];
    const l = Math.hypot(bx - ax, by - ay);
    if (d <= l) return [ax + ((bx - ax) * d) / l, ay + ((by - ay) * d) / l];
    d -= l;
  }
  return line[line.length - 1];
}

const pickTags = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => ['name', 'landuse', 'leisure', 'natural', 'amenity', 'surface', 'sport'].includes(k)));

// ================================================================== labels

const TU_RE = /\bTU\b|Technische Universität|Universität|Fakultät|Institut|Lehrstuhl|Mensa|Hörsaal/i;

function buildLabels(buildings, features) {
  const out = [];
  const add = (l) => {
    if (!inExtent([l.x, l.y])) return;
    if (out.some((o) => o.text === l.text && Math.hypot(o.x - l.x, o.y - l.y) < 120)) return;
    out.push({ ...l, x: round(l.x, 1), y: round(l.y, 1), z: round(l.z ?? 0, 1) });
  };
  for (const b of buildings.filter((b) => b.enterable)) {
    add({ text: b.short, sub: b.name ?? b.label, kind: 'fh', x: b.centroid[0], y: b.centroid[1], z: b.base + b.height + 4, building: b.id, priority: 0 });
  }
  for (const b of buildings) {
    if (b.enterable || !b.name) continue;
    const isTu = TU_RE.test(b.name) || /TU|Technische Universität/i.test(b.operator ?? '');
    if (!isTu && b.area < 400) continue;
    add({ text: b.name, kind: isTu ? 'tu' : 'building', x: b.centroid[0], y: b.centroid[1], z: b.base + b.height + 3, building: b.id, priority: isTu ? 2 : 3 });
  }
  for (const f of features) {
    const t = f.tags;
    if (!t.name) continue;
    const c = f.kind === 'point' ? f.coords : f.kind === 'polygon' ? ringCentroid(f.coords[0][0]) : null;
    if (!c) continue;
    const inFh = buildings.some((b) => b.enterable && b.footprint.some((p) => pointInPolygon(c, p)));
    if (['canteen', 'restaurant', 'cafe', 'fast_food'].includes(t.amenity) || /Mensa|kostBar/i.test(t.name)) {
      if (inFh) continue; // the FH building label already names it
      add({ text: t.name, kind: 'food', x: c[0], y: c[1], z: 8, priority: 1 });
    } else if ((t.railway === 'station' || t.railway === 'halt') && f.kind === 'point') {
      const hb = t.monorail === 'yes' || t.station === 'monorail';
      add({ text: hb ? `H-Bahn ${t.name}` : `S-Bahn ${t.name}`, kind: hb ? 'hbahn' : 'rail', x: c[0], y: c[1], z: hb ? 14 : 6, priority: 1 });
    } else if (t.highway === 'bus_stop') {
      add({ text: t.name, kind: 'bus', x: c[0], y: c[1], z: 4, priority: 2 });
    } else if ((t.amenity === 'university' || t.amenity === 'college') && !t.building && t.name !== 'Fachhochschule Dortmund') {
      add({ text: t.name, kind: /Fachhochschule/i.test(t.name) ? 'fh-site' : 'tu', x: c[0], y: c[1], z: 10, priority: 3 });
    }
  }
  log(`labels: ${out.length}`);
  return { inArea: out };
}

async function buildOffAreaLabels() {
  const els = await downloadContext();
  const out = [];
  for (const e of els) {
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (lat == null) continue;
    const [x, y] = lonLatToLocal(lon, lat);
    if (inExtent([x, y])) continue; // visible in the model, labelled there
    const t = e.tags;
    const kind = t.railway ? (t.monorail === 'yes' || t.station === 'monorail' ? 'hbahn' : 'rail') : /Mensa/i.test(t.name) || t.amenity === 'canteen' ? 'food' : 'tu';
    const text = kind === 'hbahn' ? `H-Bahn ${t.name}` : kind === 'rail' ? `S-Bahn ${t.name}` : t.name;
    if (out.some((o) => o.text === text)) continue;
    out.push({ text, kind, x: round(x, 1), y: round(y, 1), distance: Math.round(Math.hypot(x, y)) });
  }
  out.sort((a, b) => a.distance - b.distance);
  log(`off-area pointers: ${out.map((o) => `${o.text} (${o.distance} m)`).join(', ') || 'none'}`);
  return out.slice(0, 8);
}

// ================================================================== misc

function overpassTurboQuery() {
  return `[out:json][timeout:180][bbox:{{bbox}}];\n(node;way;rel[type~"^(multipolygon|building)$"];);\n(._;>;);\nout body qt;\n` +
    `(zoom Overpass Turbo to the box ${JSON.stringify(boxLonLat())} first)`;
}

function boxLonLat() {
  const [w, s] = localToLonLat(-EXTENT, -EXTENT), [e, n] = localToLonLat(EXTENT, EXTENT);
  return { south: +s.toFixed(5), west: +w.toFixed(5), north: +n.toFixed(5), east: +e.toFixed(5) };
}

function report() {
  let total = 0;
  log('baked files:');
  for (const f of fs.readdirSync(OUT_DIR)) {
    const size = fs.statSync(path.join(OUT_DIR, f)).size;
    total += size;
    log(`  ${f.padEnd(18)} ${(size / 1e6).toFixed(2).padStart(6)} MB`);
  }
  log(`  ${'total'.padEnd(18)} ${(total / 1e6).toFixed(2).padStart(6)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
