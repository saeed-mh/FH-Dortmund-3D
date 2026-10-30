// NRW open geodata (Geobasis NRW, Datenlizenz Deutschland – Zero 2.0):
// DGM1 terrain, DOP aerial orthophoto (via the official WMS) and LoD2 CityGML buildings.

import { fromArrayBuffer } from 'geotiff';
import sharp from 'sharp';
import { ShapeUtils, Vector2 } from 'three';
import { NRW, ORTHO_QUALITY, TERRAIN_CELL } from './config.mjs';
import { EXTENT, ORIGIN, cachedFetch, log, round, warn } from './util.mjs';

/** The 1 km tiles (EPSG:25832 km indices) that cover the baked area. */
function tiles() {
  const out = [];
  const e0 = Math.floor((ORIGIN.e - EXTENT) / 1000), e1 = Math.floor((ORIGIN.e + EXTENT) / 1000);
  const n0 = Math.floor((ORIGIN.n - EXTENT) / 1000), n1 = Math.floor((ORIGIN.n + EXTENT) / 1000);
  for (let e = e0; e <= e1; e++) for (let n = n0; n <= n1; n++) out.push({ e, n });
  return out;
}

async function tileFiles(indexUrl, cacheName, pattern) {
  const idx = (await cachedFetch(cacheName, indexUrl, { timeout: 300_000 })).toString('utf8');
  return tiles().map((t) => {
    const re = pattern(t);
    const m = idx.match(re);
    if (!m) throw new Error(`tile ${t.e}_${t.n} not listed in ${indexUrl}`);
    return { ...t, name: m[1] };
  });
}

// ---------------------------------------------------------------- terrain (DGM1)

export async function bakeTerrain() {
  const files = await tileFiles(NRW.dgm1Index, 'dgm1-index.xml', ({ e, n }) => new RegExp(`name="(dgm1_32_${e}_${n}_1_nw_\\d{4}\\.tif)"`));
  const rasters = [];
  for (const f of files) {
    log(`DGM1 tile ${f.name}`);
    const buf = await cachedFetch(f.name, NRW.dgm1Index + f.name, { timeout: 300_000 });
    const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const img = await tiff.getImage();
    const [minE, minN, maxE, maxN] = img.getBoundingBox();
    const [data] = await img.readRasters();
    rasters.push({ minE, minN, maxE, maxN, w: img.getWidth(), h: img.getHeight(), data, nodata: Number(img.getGDALNoData() ?? -9999) });
  }
  const sample = (E, N) => {
    for (const r of rasters) {
      if (E < r.minE || E > r.maxE || N < r.minN || N > r.maxN) continue;
      // pixel-is-area: pixel centres at minE + (i + 0.5) * res
      const fx = Math.min(r.w - 1.001, Math.max(0, (E - r.minE) / ((r.maxE - r.minE) / r.w) - 0.5));
      const fy = Math.min(r.h - 1.001, Math.max(0, (r.maxN - N) / ((r.maxN - r.minN) / r.h) - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const at = (x, y) => r.data[y * r.w + x];
      const v = [at(x0, y0), at(x0 + 1, y0), at(x0, y0 + 1), at(x0 + 1, y0 + 1)];
      if (v.some((h) => h === r.nodata || !Number.isFinite(h))) return v.find((h) => h !== r.nodata && Number.isFinite(h)) ?? null;
      return (v[0] * (1 - tx) + v[1] * tx) * (1 - ty) + (v[2] * (1 - tx) + v[3] * tx) * ty;
    }
    return null;
  };
  const cells = Math.round((2 * EXTENT) / TERRAIN_CELL);
  const n = cells + 1;
  const heights = new Float64Array(n * n);
  let min = Infinity, max = -Infinity, missing = 0;
  // Row 0 is the north edge so the grid reads like an image.
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let h = sample(ORIGIN.e - EXTENT + i * TERRAIN_CELL, ORIGIN.n + EXTENT - j * TERRAIN_CELL);
    if (h == null) { missing++; h = NaN; }
    heights[j * n + i] = h;
    if (Number.isFinite(h)) { min = Math.min(min, h); max = Math.max(max, h); }
  }
  if (missing) warn(`${missing} terrain samples missing; filled with the minimum`);
  for (let k = 0; k < heights.length; k++) if (!Number.isFinite(heights[k])) heights[k] = min;
  const base = round(sample(ORIGIN.e, ORIGIN.n) ?? min, 2);
  const q = new Uint16Array(n * n);
  const span = Math.max(max - min, 0.01);
  for (let k = 0; k < q.length; k++) q[k] = Math.round(((heights[k] - min) / span) * 65535);
  log(`terrain ${n}x${n} @ ${TERRAIN_CELL} m, ${min.toFixed(1)}–${max.toFixed(1)} m NHN, base ${base} m`);
  const heightAt = (x, y) => {
    const i = Math.max(0, Math.min(n - 1, (x + EXTENT) / TERRAIN_CELL));
    const j = Math.max(0, Math.min(n - 1, (EXTENT - y) / TERRAIN_CELL));
    const i0 = Math.min(n - 2, Math.floor(i)), j0 = Math.min(n - 2, Math.floor(j)), ti = i - i0, tj = j - j0;
    const at = (a, b) => heights[b * n + a];
    return (at(i0, j0) * (1 - ti) + at(i0 + 1, j0) * ti) * (1 - tj) + (at(i0, j0 + 1) * (1 - ti) + at(i0 + 1, j0 + 1) * ti) * tj - base;
  };
  return {
    bin: Buffer.from(q.buffer),
    meta: {
      file: 'terrain.bin', encoding: 'uint16-le, row-major, row 0 = north edge',
      size: n, cell: TERRAIN_CELL, minX: -EXTENT, maxY: EXTENT,
      minHeight: round(min - base, 3), maxHeight: round(max - base, 3),
      decode: 'height = minHeight + value / 65535 * (maxHeight - minHeight)  (metres above baseElevation)',
      source: files.map((f) => f.name),
    },
    baseElevation: base,
    heightAt,
  };
}

// ---------------------------------------------------------------- orthophoto (DOP via WMS)

export async function bakeOrtho(size) {
  const bbox = [ORIGIN.e - EXTENT, ORIGIN.n - EXTENT, ORIGIN.e + EXTENT, ORIGIN.n + EXTENT].join(',');
  const url = `${NRW.dopWms}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${NRW.dopLayer}&STYLES=&CRS=EPSG:25832&BBOX=${bbox}&WIDTH=${size}&HEIGHT=${size}&FORMAT=image/png`;
  log(`DOP orthophoto ${size}px via WMS`);
  const png = await cachedFetch(`dop-${size}.png`, url, { timeout: 600_000, accept: /^image\// });
  const webp = await sharp(png).webp({ quality: ORTHO_QUALITY, effort: 6 }).toBuffer();
  log(`orthophoto ${(webp.length / 1e6).toFixed(2)} MB WebP`);
  return {
    webp,
    meta: { file: 'ortho.webp', size, minX: -EXTENT, minY: -EXTENT, maxX: EXTENT, maxY: EXTENT, metresPerPixel: round((2 * EXTENT) / size, 3), source: `${NRW.dopWms} layer ${NRW.dopLayer}` },
  };
}

// ---------------------------------------------------------------- LoD2 (CityGML)

/**
 * Parses LoD2 buildings whose ground centroid lies within the baked area.
 * Returns [{ gmlId, ground: [[x,y]...], groundZ, topZ, measuredHeight, roofType, surfaces: [{ kind, rings: [[[x,y,z]...]...] }] }]
 * Coordinates: local x/y, z = metres above baseElevation.
 */
export async function loadLod2(baseElevation) {
  const files = await tileFiles(NRW.lod2Index, 'lod2-index.xml', ({ e, n }) => new RegExp(`name="(LoD2_32_${e}_${n}_1_NW\\.gml)"`));
  const out = [];
  for (const f of files) {
    log(`LoD2 tile ${f.name}`);
    const text = (await cachedFetch(f.name, NRW.lod2Index + f.name, { timeout: 600_000 })).toString('utf8');
    for (const m of text.matchAll(/<core:cityObjectMember>([\s\S]*?)<\/core:cityObjectMember>/g)) {
      const b = parseBuilding(m[1], baseElevation);
      if (b && Math.abs(b.centre[0]) <= EXTENT && Math.abs(b.centre[1]) <= EXTENT) out.push(b);
    }
  }
  log(`LoD2: ${out.length} buildings in area`);
  return out;
}

const SURFACE_KIND = { RoofSurface: 'roof', WallSurface: 'wall', GroundSurface: 'ground', ClosureSurface: 'wall', OuterFloorSurface: 'roof', OuterCeilingSurface: 'wall' };

function parseBuilding(xml, base) {
  const id = xml.match(/<bldg:Building gml:id="([^"]+)"/)?.[1];
  if (!id) return null;
  const surfaces = [];
  for (const s of xml.matchAll(/<bldg:(RoofSurface|WallSurface|GroundSurface|ClosureSurface|OuterFloorSurface|OuterCeilingSurface)\b[\s\S]*?<\/bldg:\1>/g)) {
    const kind = SURFACE_KIND[s[1]];
    for (const poly of s[0].matchAll(/<gml:Polygon\b[\s\S]*?<\/gml:Polygon>/g)) {
      const rings = [];
      for (const r of poly[0].matchAll(/<gml:(exterior|interior)>([\s\S]*?)<\/gml:\1>/g)) {
        const ring = posList(r[2], base);
        if (ring.length >= 3) rings.push(ring);
      }
      if (rings.length) surfaces.push({ kind, rings });
    }
  }
  if (!surfaces.length) return null;
  let ground = surfaces.filter((s) => s.kind === 'ground').map((s) => s.rings[0]);
  const all = surfaces.flatMap((s) => s.rings.flat());
  const zs = all.map((p) => p[2]);
  const groundZ = Math.min(...zs), topZ = Math.max(...zs);
  if (!ground.length) ground = [all];
  const gpts = ground.flat();
  const centre = [gpts.reduce((a, p) => a + p[0], 0) / gpts.length, gpts.reduce((a, p) => a + p[1], 0) / gpts.length];
  return {
    gmlId: id,
    centre,
    ground: ground.map((r) => r.map(([x, y]) => [x, y])),
    groundZ: round(groundZ, 2),
    topZ: round(topZ, 2),
    measuredHeight: Number(xml.match(/<bldg:measuredHeight[^>]*>([\d.]+)</)?.[1] ?? NaN) || round(topZ - groundZ, 2),
    roofType: xml.match(/<bldg:roofType[^>]*>([^<]+)</)?.[1] ?? null,
    surfaces,
  };
}

function posList(xml, base) {
  let nums;
  const pl = xml.match(/<gml:posList[^>]*>([^<]+)<\/gml:posList>/);
  if (pl) nums = pl[1].trim().split(/\s+/).map(Number);
  else nums = [...xml.matchAll(/<gml:pos[^>]*>([^<]+)<\/gml:pos>/g)].flatMap((m) => m[1].trim().split(/\s+/).map(Number));
  const ring = [];
  for (let i = 0; i + 2 < nums.length; i += 3) ring.push([nums[i] - ORIGIN.e, nums[i + 1] - ORIGIN.n, nums[i + 2] - base]);
  if (ring.length > 1) {
    const a = ring[0], b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) ring.pop();
  }
  return ring;
}

/**
 * Bakes LoD2 walls and roofs of the given buildings into two merged, indexed meshes.
 * Each vertex carries the index of its building (into `buildingIndex`) for picking.
 */
export function bakeLod2Mesh(buildings) {
  const parts = { wall: { pos: [], idx: [], bid: [] }, roof: { pos: [], idx: [], bid: [] } };
  buildings.forEach((b, bi) => {
    for (const s of b.surfaces) {
      if (s.kind === 'ground') continue;
      const target = parts[s.kind === 'roof' ? 'roof' : 'wall'];
      triangulate3d(s.rings, target, bi);
    }
  });
  const chunks = [];
  const layout = {};
  let offset = 0;
  const push = (name, typed) => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
    layout[name] = { offset, length: typed.length };
    chunks.push(Buffer.from(typed.buffer));
    offset += typed.byteLength;
  };
  for (const k of ['wall', 'roof']) {
    push(`${k}Position`, new Float32Array(parts[k].pos));
    push(`${k}Index`, new Uint32Array(parts[k].idx));
    push(`${k}Building`, new Uint16Array(parts[k].bid));
  }
  return { bin: Buffer.concat(chunks), layout };
}

function triangulate3d(rings, target, bi) {
  const outer = rings[0];
  // Newell normal of the outer ring picks the projection plane.
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < outer.length; i++) {
    const [x1, y1, z1] = outer[i], [x2, y2, z2] = outer[(i + 1) % outer.length];
    nx += (y1 - y2) * (z1 + z2); ny += (z1 - z2) * (x1 + x2); nz += (x1 - x2) * (y1 + y2);
  }
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-6) return;
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const proj = az >= ax && az >= ay ? (p) => new Vector2(p[0], p[1]) : ax >= ay ? (p) => new Vector2(p[1], p[2]) : (p) => new Vector2(p[2], p[0]);
  const contour = outer.map(proj);
  const holes = rings.slice(1).map((r) => r.map(proj));
  let faces;
  try {
    faces = ShapeUtils.triangulateShape(contour, holes);
  } catch {
    return;
  }
  const verts = [...outer, ...rings.slice(1).flat()];
  const base = target.pos.length / 3;
  for (const v of verts) target.pos.push(round(v[0], 3), round(v[2], 3), round(-v[1], 3)); // three.js: y up, -z north
  for (let k = 0; k < verts.length; k++) target.bid.push(bi);
  for (const [a, b, c] of faces) {
    // keep the triangle facing along the polygon normal
    const A = verts[a], B = verts[b], C = verts[c];
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    const dot = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
    if (dot >= 0) target.idx.push(base + a, base + b, base + c);
    else target.idx.push(base + a, base + c, base + b);
  }
}
