import fs from 'node:fs';
import path from 'node:path';
import proj4 from 'proj4';
import { CACHE_DIR, CENTRE, CRS, CRS_DEF, HALF_SIZE, MARGIN, USER_AGENT } from './config.mjs';

proj4.defs(CRS, CRS_DEF);

// ---------------------------------------------------------------- local coordinate system
// Local metres: x = east, y = north, relative to ORIGIN (the centre projected to EPSG:25832 and
// rounded to whole metres). Elevations are metres above `baseElevation` (DGM height at the origin).
const [ce, cn] = proj4('EPSG:4326', CRS, [CENTRE.lon, CENTRE.lat]);
export const ORIGIN = { e: Math.round(ce), n: Math.round(cn) };
export const EXTENT = HALF_SIZE + MARGIN; // baked half-extent in metres

export const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
export const lonLatToLocal = (lon, lat) => {
  const [e, n] = proj4('EPSG:4326', CRS, [lon, lat]);
  return [e - ORIGIN.e, n - ORIGIN.n];
};
export const localToLonLat = (x, y) => proj4(CRS, 'EPSG:4326', [x + ORIGIN.e, y + ORIGIN.n]);
export const inExtent = ([x, y], pad = 0) => Math.abs(x) <= EXTENT + pad && Math.abs(y) <= EXTENT + pad;

// ---------------------------------------------------------------- logging
export const log = (...a) => console.log('[geodata]', ...a);
export const warn = (...a) => console.warn('[geodata] WARN', ...a);

// ---------------------------------------------------------------- network with on-disk cache
export const opts = { offline: false, refresh: false };

export function cachePath(name) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  return path.join(CACHE_DIR, name);
}

/** Fetch `url` (or POST `body`) and cache the bytes as `cacheName`. Returns a Buffer. */
export async function cachedFetch(cacheName, url, { body, timeout = 180_000, retries = 2, accept } = {}) {
  const file = cachePath(cacheName);
  if (fs.existsSync(file) && !opts.refresh) return fs.readFileSync(file);
  if (opts.offline) throw new Error(`offline and not cached: ${cacheName}`);
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        body,
        headers: {
          'User-Agent': USER_AGENT,
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const type = res.headers.get('content-type') ?? '';
      if (accept && !accept.test(type)) {
        const text = (await res.text()).slice(0, 300);
        throw new Error(`unexpected content-type ${type} for ${url}: ${text}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      return buf;
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(3000 * (i + 1));
    }
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- planar geometry (local metres)
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return a / 2; // > 0 for counter-clockwise rings
}

export function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const pointInPolygon = (p, rings) => pointInRing(p, rings[0]) && !rings.slice(1).some((h) => pointInRing(p, h));

export function distToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distToRing(p, ring) {
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) d = Math.min(d, distToSegment(p, ring[i], ring[(i + 1) % ring.length]));
  return d;
}

/** Drops the closing duplicate point and consecutive duplicates. */
export function openRing(ring) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-3) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3) out.pop();
  }
  return out;
}

export const roundRing = (ring, d = 2) => ring.map(([x, y]) => [round(x, d), round(y, d)]);

export function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Minimum-area oriented bounding box. `angle` is the direction of the long axis (radians). */
export function orientedBox(ring) {
  const hull = convexHull(ring);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i], [bx, by] = hull[(i + 1) % hull.length];
    const ang = Math.atan2(by - ay, bx - ax);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of hull) {
      const u = x * c - y * s, v = x * s + y * c;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, angle: ang, u0, u1, v0, v1 };
  }
  if (best.u1 - best.u0 < best.v1 - best.v0) {
    // rotate the frame by 90° so u is always the long axis
    const { u0, u1, v0, v1 } = best;
    best = { area: best.area, angle: best.angle + Math.PI / 2, u0: v0, u1: v1, v0: -u1, v1: -u0 };
  }
  return best;
}

export function polylineLength(line) {
  let l = 0;
  for (let i = 1; i < line.length; i++) l += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return l;
}

/** Deterministic pseudo-random generator so re-runs bake identical files. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
