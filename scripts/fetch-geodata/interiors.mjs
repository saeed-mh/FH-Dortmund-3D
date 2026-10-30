// Generates an assumed floor plan for each enterable building, constrained to its real footprint.
// Layout: the footprint's oriented bounding box is cut into bands of [rooms | corridor | rooms];
// cross corridors with stair cores run across the bands, and every entrance gets a connector
// corridor. Everything is clipped to the footprint polygon, so nothing leaves the real outline.

import pc from 'polygon-clipping';
import { orientedBox, ringArea, ringCentroid, round, roundRing } from './util.mjs';

const CORRIDOR = 2.4;
const ROOM_DEPTH = 6.5;
const ROOM_WIDTH = 4.8;
const CROSS_SPACING = 36;
const STAIR = { u: 4.5, v: 6 };
const MIN_ROOM_AREA = 7;

/**
 * @param b building record ({ footprint: [[outer, ...holes], ...], levels, height, short, key })
 * @param entrances [{ x, y, assumed }]
 */
export function generateInterior(b, entrances) {
  const footprint = b.footprint.map((poly) => poly.map((r) => r.map(([x, y]) => [x, y])));
  const main = footprint.reduce((a, p) => (Math.abs(ringArea(p[0])) > Math.abs(ringArea(a[0])) ? p : a));
  const box = orientedBox(main[0]);
  const c = Math.cos(box.angle), s = Math.sin(box.angle);
  // frame (u along the long axis, v across) -> local x/y
  const toXY = ([u, v]) => [u * c - v * s, u * s + v * c];
  const toUV = ([x, y]) => [x * c + y * s, -x * s + y * c];
  // snapped to cm: polygon-clipping is sensitive to nearly-collinear float input
  const rect = (u0, u1, v0, v1) => [[[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(toXY).map(([x, y]) => [round(x, 2), round(y, 2)])];
  const { u0, u1, v0, v1 } = box;
  const width = v1 - v0, length = u1 - u0;

  // ---- bands along the long axis
  const bandCount = Math.max(1, Math.round(width / (2 * ROOM_DEPTH + CORRIDOR)));
  const bandW = width / bandCount;
  const corridorRects = [];
  const corridorV = [];
  const roomStrips = [];
  for (let k = 0; k < bandCount; k++) {
    const b0 = v0 + k * bandW, b1 = b0 + bandW;
    if (bandW < 2 * 4 + CORRIDOR) {
      // narrow: single-loaded corridor along the side nearer the box centre
      const cv = k < bandCount / 2 ? b1 - CORRIDOR : b0;
      corridorRects.push(rect(u0 - 1, u1 + 1, cv, cv + CORRIDOR));
      corridorV.push(cv + CORRIDOR / 2);
      roomStrips.push(cv === b0 ? [b0 + CORRIDOR, b1] : [b0, b1 - CORRIDOR]);
    } else {
      const m = (b0 + b1) / 2;
      corridorRects.push(rect(u0 - 1, u1 + 1, m - CORRIDOR / 2, m + CORRIDOR / 2));
      corridorV.push(m);
      roomStrips.push([b0, m - CORRIDOR / 2], [m + CORRIDOR / 2, b1]);
    }
  }

  // ---- cross corridors (and stair cores) at regular spacing and at each entrance on a long side
  const crossU = [];
  const nCross = Math.max(1, Math.round(length / CROSS_SPACING));
  for (let k = 0; k < nCross; k++) crossU.push(u0 + (length * (k + 0.5)) / nCross);
  const fp = footprint;
  const connectors = [];
  for (const e of entrances) {
    const [eu, ev] = toUV([e.x, e.y]);
    const vc = corridorV.reduce((a, v) => (Math.abs(v - ev) < Math.abs(a - ev) ? v : a));
    const onLongSide = Math.min(Math.abs(ev - v0), Math.abs(ev - v1)) < Math.min(Math.abs(eu - u0), Math.abs(eu - u1));
    if (onLongSide) {
      if (bandCount > 1) crossU.push(eu);
      // straight connector from the door to the nearest band corridor
      connectors.push(rect(eu - CORRIDOR / 2, eu + CORRIDOR / 2, Math.min(ev, vc) - 1, Math.max(ev, vc) + 1));
    } else {
      // door on a short side: a hall from the door across to the band corridor
      const du = eu < (u0 + u1) / 2 ? 1 : -1;
      const ua = eu - du, ub = eu + du * ROOM_WIDTH;
      connectors.push(rect(Math.min(ua, ub), Math.max(ua, ub), Math.min(ev, vc) - CORRIDOR / 2, Math.max(ev, vc) + CORRIDOR / 2));
    }
  }
  crossU.sort((a, b) => a - b);
  const cross = crossU.filter((u, i) => i === 0 || u - crossU[i - 1] > 8);
  const stairs = [];
  for (const u of cross) {
    if (bandCount > 1) corridorRects.push(rect(u - CORRIDOR / 2, u + CORRIDOR / 2, v0 - 1, v1 + 1));
    // stair core beside the cross corridor, in the first room strip
    const [s0, s1] = roomStrips[0];
    stairs.push(rect(u + CORRIDOR / 2, u + CORRIDOR / 2 + STAIR.u, Math.max(s0, s1 - STAIR.v), s1));
  }

  const corridors = clip(safe(() => pc.union(...corridorRects, ...connectors)), fp);
  const stairPolys = clip(safe(() => pc.difference(pc.union(...stairs), corridors)), fp);
  const blocked = safe(() => pc.union(corridors, stairPolys));

  // ---- room cells: slices of each room strip, clipped to the footprint, minus corridors/stairs
  const cells = [];
  for (const [s0, s1] of roomStrips) {
    // split the strip at cross corridors so rooms don't straddle them
    const cuts = [u0, ...cross.flatMap((u) => [u - CORRIDOR / 2, u + CORRIDOR / 2]), u1];
    for (let k = 0; k + 1 < cuts.length; k += 2) {
      const a = cuts[k], z = cuts[k + 1];
      const n = Math.max(1, Math.round((z - a) / ROOM_WIDTH));
      for (let i = 0; i < n; i++) {
        const r = rect(a + ((z - a) * i) / n, a + ((z - a) * (i + 1)) / n, s0, s1);
        for (const piece of safe(() => pc.difference(pc.intersection(r, fp), blocked))) {
          const area = Math.abs(ringArea(piece[0])) - piece.slice(1).reduce((t, h) => t + Math.abs(ringArea(h)), 0);
          if (area >= MIN_ROOM_AREA) cells.push({ rings: piece.map((r) => r.slice(0, -1)), area });
        }
      }
    }
  }
  // stable order: along the long axis, then across
  cells.sort((p, q) => {
    const [pu, pv] = toUV(ringCentroid(p.rings[0])), [qu, qv] = toUV(ringCentroid(q.rings[0]));
    return Math.round(pv / 4) - Math.round(qv / 4) || pu - qu;
  });

  const floors = Math.max(1, b.levels);
  const rooms = [];
  for (let f = 0; f < floors; f++) {
    cells.forEach((cell, i) => {
      const number = `${f}.${String(i + 1).padStart(2, '0')}`;
      rooms.push({
        id: `${b.key}-${number}`,
        number,
        floor: f,
        type: roomType(cell.area, f, i),
        area: round(cell.area, 1),
        centroid: ringCentroid(cell.rings[0]).map((v) => round(v, 2)),
        polygon: cell.rings.map((r) => roundRing(r)),
      });
    });
  }
  return {
    buildingId: b.id,
    key: b.key,
    floors,
    floorHeight: b.floorHeight,
    angle: round(box.angle, 4),
    generated: true,
    note: 'Room layout is generated from the real footprint and floor count; it is not the real floor plan.',
    entrances,
    corridors: corridors.map((p) => p.map((r) => roundRing(r))),
    stairs: stairPolys.map((p) => p.map((r) => roundRing(r))),
    rooms,
  };
}

function clip(geom, footprint) {
  return safe(() => pc.intersection(geom, footprint)).map((poly) => poly.map((r) => r.slice(0, -1).map(([x, y]) => [round(x, 2), round(y, 2)])));
}

/** polygon-clipping occasionally fails on degenerate input; a missing room is better than a crash. */
function safe(op) {
  try {
    return op();
  } catch {
    return [];
  }
}

function roomType(area, floor, index) {
  if (floor === 0 && index === 0) return 'info';
  if (index % 11 === 3) return 'wc';
  if (area >= 45) return 'lecture';
  if (area >= 28) return index % 2 ? 'lab' : 'seminar';
  return 'office';
}
