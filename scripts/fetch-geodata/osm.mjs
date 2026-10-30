// OpenStreetMap download and parsing into a source-neutral list of features in local metres.
// Accepted inputs: Overpass / OSM API JSON ("elements"), .osm XML, and GeoJSON (Overpass Turbo export).

import fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { CONTEXT_RADIUS, CENTRE, OSM_API_MAP, OVERPASS_ENDPOINTS } from './config.mjs';
import { EXTENT, cachedFetch, lonLatToLocal, localToLonLat, log, openRing, pointInRing, ringArea, warn } from './util.mjs';

function bboxLonLat(pad) {
  const [w, s] = localToLonLat(-EXTENT - pad, -EXTENT - pad);
  const [e, n] = localToLonLat(EXTENT + pad, EXTENT + pad);
  return { s, w, n, e };
}

// ---------------------------------------------------------------- download

export async function downloadOsm() {
  const { s, w, n, e } = bboxLonLat(20);
  const bb = [s, w, n, e].map((v) => v.toFixed(6)).join(',');
  // Everything in the box, plus complete member ways of multipolygons that reach into it.
  const query = `[out:json][timeout:180][bbox:${bb}];(node;way;rel[type~"^(multipolygon|building)$"];);(._;>;);out body qt;`;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      log(`Overpass: ${url}`);
      const buf = await cachedFetch('osm-overpass.json', url, { body: 'data=' + encodeURIComponent(query), accept: /json/ });
      return { data: JSON.parse(buf.toString('utf8')), source: `Overpass API (${new URL(url).host})` };
    } catch (err) {
      warn(`Overpass failed (${url}): ${err.message}`);
    }
  }
  // Fallback: the main OSM API map call. Same data, but multipolygon members outside the box are missing.
  log('Falling back to the OSM API map call');
  const url = `${OSM_API_MAP}?bbox=${[w, s, e, n].map((v) => v.toFixed(6)).join(',')}`;
  const buf = await cachedFetch('osm-api.json', url, { accept: /json/ });
  return { data: JSON.parse(buf.toString('utf8')), source: 'OpenStreetMap API 0.6 /map' };
}

/** Named landmarks around the area, used for edge pointers when they fall outside it. */
export async function downloadContext() {
  const r = CONTEXT_RADIUS;
  const at = `${CENTRE.lat},${CENTRE.lon}`;
  const query = `[out:json][timeout:90];(
    nwr[railway~"^(station|halt)$"][name](around:${r},${at});
    nwr[amenity~"^(canteen|university|college)$"][name](around:${r},${at});
    nwr[building][name~"Mensa"](around:${r},${at});
  );out center tags;`;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const buf = await cachedFetch('osm-context.json', url, { body: 'data=' + encodeURIComponent(query), accept: /json/ });
      return JSON.parse(buf.toString('utf8')).elements;
    } catch (err) {
      warn(`context query failed (${url}): ${err.message}`);
    }
  }
  return [];
}

// ---------------------------------------------------------------- local file input

export function readOsmFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) return { data: parseOsmXml(text), source: `local OSM XML (${file})` };
  const json = JSON.parse(text);
  if (json.type === 'FeatureCollection') return { geojson: json, source: `local GeoJSON (${file})` };
  if (Array.isArray(json.elements)) return { data: json, source: `local OSM JSON (${file})` };
  throw new Error(`Unrecognised OSM file: ${file} (expected OSM JSON, .osm XML or GeoJSON)`);
}

function parseOsmXml(text) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', isArray: (n) => ['node', 'way', 'relation', 'tag', 'nd', 'member'].includes(n) });
  const osm = parser.parse(text).osm;
  const tags = (t) => Object.fromEntries((t ?? []).map((x) => [x.k, String(x.v)]));
  const elements = [
    ...(osm.node ?? []).map((n) => ({ type: 'node', id: +n.id, lat: +n.lat, lon: +n.lon, tags: tags(n.tag) })),
    ...(osm.way ?? []).map((w) => ({ type: 'way', id: +w.id, nodes: (w.nd ?? []).map((nd) => +nd.ref), tags: tags(w.tag) })),
    ...(osm.relation ?? []).map((r) => ({
      type: 'relation', id: +r.id, tags: tags(r.tag),
      members: (r.member ?? []).map((m) => ({ type: m.type, ref: +m.ref, role: m.role ?? '' })),
    })),
  ];
  return { elements };
}

// ---------------------------------------------------------------- features

const AREA_KEYS = ['building', 'building:part', 'landuse', 'leisure', 'natural', 'amenity', 'area:highway', 'place', 'man_made', 'water', 'parking', 'shop', 'tourism'];
const LINEAR_NATURAL = new Set(['tree_row', 'coastline', 'cliff', 'ridge', 'arete']);

function isAreaWay(tags, closed) {
  if (!closed) return false;
  if (tags.area === 'no') return false;
  if (tags.area === 'yes') return true;
  if (tags.highway || tags.railway || tags.barrier || tags.waterway) return false;
  if (tags.natural && LINEAR_NATURAL.has(tags.natural)) return false;
  return AREA_KEYS.some((k) => k in tags);
}

/**
 * Returns features: { osm: 'way/123', tags, kind: 'point'|'line'|'polygon', coords }
 * point: [x, y]; line: [[x, y]...]; polygon: [[outer, ...holes], ...] (a multipolygon).
 */
export function toFeatures(input) {
  if (input.geojson) return geojsonFeatures(input.geojson);
  const els = input.data.elements;
  const nodes = new Map(), ways = new Map(), rels = [];
  for (const el of els) {
    if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'way') ways.set(el.id, el);
    else if (el.type === 'relation') rels.push(el);
  }
  const loc = new Map();
  const nodeXY = (id) => {
    if (!loc.has(id)) {
      const n = nodes.get(id);
      loc.set(id, n ? lonLatToLocal(n.lon, n.lat) : null);
    }
    return loc.get(id);
  };
  const out = [];
  for (const n of nodes.values()) {
    if (n.tags && Object.keys(n.tags).length) out.push({ osm: `node/${n.id}`, tags: n.tags, kind: 'point', coords: nodeXY(n.id) });
  }
  const wayCoords = (w) => {
    const c = w.nodes.map(nodeXY);
    return c.includes(null) ? null : c;
  };
  for (const w of ways.values()) {
    if (!w.tags || !Object.keys(w.tags).length) continue;
    const c = wayCoords(w);
    if (!c || c.length < 2) continue;
    const closed = w.nodes.length > 3 && w.nodes[0] === w.nodes[w.nodes.length - 1];
    if (isAreaWay(w.tags, closed)) out.push({ osm: `way/${w.id}`, tags: w.tags, kind: 'polygon', coords: [[openRing(c)]], nodeIds: w.nodes });
    else out.push({ osm: `way/${w.id}`, tags: w.tags, kind: 'line', coords: c, nodeIds: w.nodes });
  }
  for (const r of rels) {
    if (r.tags?.type !== 'multipolygon') continue;
    const outer = [], inner = [];
    let incomplete = false;
    for (const m of r.members) {
      if (m.type !== 'way') continue;
      const w = ways.get(m.ref);
      const c = w && wayCoords(w);
      if (!c) { incomplete = true; continue; }
      (m.role === 'inner' ? inner : outer).push(c);
    }
    const outers = joinRings(outer), inners = joinRings(inner);
    if (!outers.length) continue;
    if (incomplete) warn(`relation/${r.id} (${r.tags.name ?? Object.keys(r.tags).find((k) => k !== 'type')}) is incomplete; using closed rings only`);
    const polys = outers.map((o) => [o]);
    for (const h of inners) {
      const host = polys.find((p) => pointInRing(h[0], p[0]));
      if (host) host.push(h);
    }
    out.push({ osm: `relation/${r.id}`, tags: r.tags, kind: 'polygon', coords: polys });
  }
  return out;
}

/** Joins way segments end to end into closed rings; unclosed leftovers are dropped. */
function joinRings(segments) {
  const segs = segments.map((s) => [...s]);
  const rings = [];
  const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01;
  while (segs.length) {
    let ring = segs.shift();
    let grown = true;
    while (!same(ring[0], ring[ring.length - 1]) && grown) {
      grown = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const end = ring[ring.length - 1];
        if (same(end, s[0])) ring = ring.concat(s.slice(1));
        else if (same(end, s[s.length - 1])) ring = ring.concat([...s].reverse().slice(1));
        else continue;
        segs.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (same(ring[0], ring[ring.length - 1]) && ring.length > 3) rings.push(openRing(ring));
  }
  return rings;
}

function geojsonFeatures(fc) {
  const out = [];
  const conv = (c) => lonLatToLocal(c[0], c[1]);
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const tags = { ...(p.tags ?? {}) };
    for (const [k, v] of Object.entries(p)) if (!k.startsWith('@') && k !== 'tags' && k !== 'id' && typeof v !== 'object') tags[k] = String(v);
    const osm = String(p['@id'] ?? f.id ?? p.id ?? 'unknown');
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Point') out.push({ osm, tags, kind: 'point', coords: conv(g.coordinates) });
    else if (g.type === 'LineString') out.push({ osm, tags, kind: 'line', coords: g.coordinates.map(conv) });
    else if (g.type === 'MultiLineString') g.coordinates.forEach((l) => out.push({ osm, tags, kind: 'line', coords: l.map(conv) }));
    else if (g.type === 'Polygon') out.push({ osm, tags, kind: 'polygon', coords: [g.coordinates.map((r) => openRing(r.map(conv)))] });
    else if (g.type === 'MultiPolygon') out.push({ osm, tags, kind: 'polygon', coords: g.coordinates.map((poly) => poly.map((r) => openRing(r.map(conv)))) });
  }
  return out;
}

/** Normalises winding: outer rings counter-clockwise, holes clockwise. */
export function normalisePolygon(polys) {
  return polys
    .map((rings) => rings.map((r, i) => {
      const ccw = ringArea(r) > 0;
      return (i === 0) === ccw ? r : [...r].reverse();
    }))
    .filter((rings) => rings[0].length >= 3);
}

export { EXTENT };
