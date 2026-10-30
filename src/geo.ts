import * as THREE from 'three';
import type { Meta, XY } from './data';

// Local map metres (x east, y north) -> three.js scene: X = x, Y = elevation, Z = -y.
export const toScene = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);

/** Bilinear height lookup on the baked DGM grid (metres above meta.baseElevation). */
export class Terrain {
  readonly size: number;
  readonly cell: number;
  readonly extent: number;
  private heights: Float32Array;

  constructor(meta: Meta, raw: Uint16Array | null) {
    this.extent = meta.bounds.extent;
    const t = meta.terrain;
    if (!t || !raw) {
      this.size = 2;
      this.cell = this.extent * 2;
      this.heights = new Float32Array(4);
      return;
    }
    this.size = t.size;
    this.cell = t.cell;
    this.heights = new Float32Array(raw.length);
    const span = t.maxHeight - t.minHeight;
    for (let i = 0; i < raw.length; i++) this.heights[i] = t.minHeight + (raw[i] / 65535) * span;
  }

  /** Height at grid vertex (i from west, j from north). */
  at(i: number, j: number) {
    return this.heights[j * this.size + i];
  }

  heightAt(x: number, y: number) {
    const n = this.size;
    const fi = THREE.MathUtils.clamp((x + this.extent) / this.cell, 0, n - 1);
    const fj = THREE.MathUtils.clamp((this.extent - y) / this.cell, 0, n - 1);
    const i0 = Math.min(n - 2, Math.floor(fi)), j0 = Math.min(n - 2, Math.floor(fj));
    const ti = fi - i0, tj = fj - j0;
    const h = this.heights;
    const a = h[j0 * n + i0] * (1 - ti) + h[j0 * n + i0 + 1] * ti;
    const b = h[(j0 + 1) * n + i0] * (1 - ti) + h[(j0 + 1) * n + i0 + 1] * ti;
    return a * (1 - tj) + b * tj;
  }
}

export function ringToShape(outer: XY[], holes: XY[][] = []) {
  const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  return shape;
}

export function bboxOf(points: XY[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** Deterministic hash -> [0, 1), so instanced props look the same on every load. */
export function hash01(x: number, y: number) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
