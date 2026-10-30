import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Building, CampusData } from '../data';
import { ringToShape } from '../geo';

const NEUTRAL_WALL = new THREE.Color('#dedbd3');
const NEUTRAL_ROOF = new THREE.Color('#a8a39b');

// Facade palettes for the FH buildings (approximate, not surveyed).
const FH_STYLE: Record<string, { wall: string; glass: string; band: string; roof: string }> = {
  efs38: { wall: '#e9e6df', glass: '#3e5a72', band: '#c6602f', roof: '#7c7f84' },
  efs38b: { wall: '#e9e6df', glass: '#3e5a72', band: '#c6602f', roof: '#7c7f84' },
  efs38c: { wall: '#e9e6df', glass: '#3e5a72', band: '#c6602f', roof: '#7c7f84' },
  efs40: { wall: '#d8d2c6', glass: '#3a4d5e', band: '#8f8576', roof: '#6f6a64' },
  efs42: { wall: '#cfd5da', glass: '#2f4a63', band: '#c6602f', roof: '#6c7176' },
  efs44: { wall: '#d6cbb9', glass: '#38506a', band: '#a0522d', roof: '#77736c' },
  kostbar: { wall: '#ece7dc', glass: '#456a80', band: '#c6602f', roof: '#7d7a73' },
};

export interface PickInfo {
  building: Building | null;
  lod2Id?: string;
}

/** All building geometry plus the lookups that turn a raycast hit into a building. */
export class Buildings {
  readonly group = new THREE.Group();
  readonly fh = new Map<string, THREE.Group>(); // building id -> detailed model
  readonly pickables: THREE.Object3D[] = [];
  readonly others = new THREE.Group();
  private byId = new Map<string, Building>();

  constructor(private data: CampusData) {
    for (const b of data.buildings.buildings) this.byId.set(b.id, b);
    this.group.add(this.others);
    this.buildLod2();
    this.buildExtruded();
    for (const b of data.buildings.buildings.filter((b) => b.enterable)) this.buildDetailed(b);
  }

  get(id: string) {
    return this.byId.get(id);
  }

  /** Maps a raycast intersection to the building it hit. */
  pick(hit: THREE.Intersection): PickInfo | null {
    const obj = hit.object;
    if (obj.userData.buildingId) return { building: this.byId.get(obj.userData.buildingId) ?? null };
    const geo = (obj as THREE.Mesh).geometry;
    const bid = geo?.getAttribute('bid');
    if (!bid || !hit.face) return null;
    const idx = bid.getX(hit.face.a);
    if (obj.userData.kind === 'lod2') {
      const info = this.data.buildings.lod2!.buildings[idx];
      return { building: info.osm ? this.byId.get(info.osm) ?? null : null, lod2Id: info.gmlId };
    }
    return { building: this.data.buildings.buildings[idx] ?? null };
  }

  // Real LoD2 shapes (Geobasis NRW) for everything that is not an FH building.
  private buildLod2() {
    const { lod2 } = this.data;
    const info = this.data.buildings.lod2;
    if (!lod2 || !info) return;
    const L = info.layout;
    for (const kind of ['wall', 'roof'] as const) {
      const pos = new Float32Array(lod2, L[`${kind}Position`].offset, L[`${kind}Position`].length);
      const idx = new Uint32Array(lod2, L[`${kind}Index`].offset, L[`${kind}Index`].length);
      const bid = new Uint16Array(lod2, L[`${kind}Building`].offset, L[`${kind}Building`].length);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('bid', new THREE.BufferAttribute(bid, 1));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: kind === 'wall' ? NEUTRAL_WALL : NEUTRAL_ROOF, roughness: 0.9, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.kind = 'lod2';
      mesh.castShadow = mesh.receiveShadow = true;
      this.others.add(mesh);
      this.pickables.push(mesh);
    }
  }

  // OSM footprints without an LoD2 match: plain extrusions.
  private buildExtruded() {
    const geos: THREE.BufferGeometry[] = [];
    this.data.buildings.buildings.forEach((b, i) => {
      if (b.render !== 'extrude') return;
      for (const g of extrude(b, b.minHeight, b.height)) {
        const n = g.getAttribute('position').count;
        g.setAttribute('bid', new THREE.BufferAttribute(new Uint16Array(n).fill(i), 1));
        g.deleteAttribute('uv');
        geos.push(g);
      }
    });
    if (!geos.length) return;
    const merged = mergeGeometries(geos.map((g) => g.toNonIndexed()), false)!;
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: NEUTRAL_WALL, roughness: 0.9 }));
    mesh.userData.kind = 'extruded';
    mesh.castShadow = mesh.receiveShadow = true;
    this.others.add(mesh);
    this.pickables.push(mesh);
  }

  // FH buildings: extruded real footprint with a per-floor window facade, parapet and roof.
  private buildDetailed(b: Building) {
    const style = FH_STYLE[b.key ?? ''] ?? FH_STYLE.efs42;
    const group = new THREE.Group();
    group.name = b.id;
    group.userData.buildingId = b.id;
    const facade = facadeTexture(style, b.floorHeight);
    const wallMat = new THREE.MeshStandardMaterial({ map: facade, roughness: 0.75, metalness: 0.05 });
    const roofMat = new THREE.MeshStandardMaterial({ color: style.roof, roughness: 0.95 });
    const plinthMat = new THREE.MeshStandardMaterial({ color: '#8b8580', roughness: 1 });

    // plinth down to the lowest terrain point so hillside buildings have no floating edge
    for (const g of extrude(b, Math.min(-0.5, b.groundMin - b.base - 0.5), 0)) addMesh(group, g, [plinthMat, plinthMat], b.id);
    for (const g of extrude(b, b.minHeight, b.height)) addMesh(group, g, [roofMat, wallMat], b.id);
    // parapet ring
    for (const poly of b.footprint) {
      const shape = ringToShape(poly[0], [inset(poly[0], 0.35)]);
      const g = new THREE.ExtrudeGeometry(shape, { depth: 0.9, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      g.translate(0, b.base + b.height, 0);
      addMesh(group, g, [plinthMat, plinthMat], b.id);
    }
    group.traverse((o) => { o.castShadow = o.receiveShadow = true; });
    this.fh.set(b.id, group);
    this.group.add(group);
    this.pickables.push(group);
  }

  /** Ghosts an FH shell while its interior is open. */
  setShellGhost(id: string | null) {
    for (const [bid, group] of this.fh) {
      const ghost = bid === id;
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const m of [mesh.material].flat() as THREE.MeshStandardMaterial[]) {
          if (m.transparent !== ghost) m.needsUpdate = true; // switching blending needs a recompile
          m.transparent = ghost;
          m.opacity = ghost ? 0.12 : 1;
          m.depthWrite = !ghost;
        }
        mesh.raycast = ghost ? () => {} : THREE.Mesh.prototype.raycast;
      });
    }
  }
}

function addMesh(group: THREE.Group, g: THREE.BufferGeometry, mats: THREE.Material[], id: string) {
  const mesh = new THREE.Mesh(g, mats);
  mesh.userData.buildingId = id;
  group.add(mesh);
}

/** Extrudes every footprint polygon from base+bottom to base+top (local -> scene axes). */
function extrude(b: Building, bottom: number, top: number) {
  return b.footprint.map((poly) => {
    const g = new THREE.ExtrudeGeometry(ringToShape(poly[0], poly.slice(1)), { depth: top - bottom, bevelEnabled: false });
    g.rotateX(-Math.PI / 2); // shape y (north) -> -Z, extrusion -> +Y
    g.translate(0, b.base + bottom, 0);
    return g;
  });
}

/** Rough inward offset of a ring (enough for a parapet; not a robust polygon offset). */
function inset(ring: [number, number][], d: number): [number, number][] {
  const n = ring.length;
  const area = ring.reduce((a, p, i) => a + (ring[(i + n - 1) % n][0] - p[0]) * (ring[(i + n - 1) % n][1] + p[1]), 0);
  const sign = area > 0 ? 1 : -1; // ccw rings: inward is to the left
  return ring.map((p, i) => {
    const a = ring[(i + n - 1) % n], c = ring[(i + 1) % n];
    const n1 = norm([-(p[1] - a[1]), p[0] - a[0]]), n2 = norm([-(c[1] - p[1]), c[0] - p[0]]);
    const m = norm([n1[0] + n2[0], n1[1] + n2[1]]);
    const cos = Math.max(0.35, m[0] * n1[0] + m[1] * n1[1]);
    return [p[0] + (sign * m[0] * d) / cos, p[1] + (sign * m[1] * d) / cos];
  });
}
const norm = ([x, y]: number[]) => {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
};

/**
 * One window bay per texture tile. ExtrudeGeometry's side UVs are in metres (u along the wall,
 * v up the extrusion), so repeat = 1 / bay size gives one window per 1.8 m per floor.
 */
function facadeTexture(style: { wall: string; glass: string; band: string }, floorHeight: number) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = style.wall; g.fillRect(0, 0, 64, 128);
  g.fillStyle = style.band; g.fillRect(0, 118, 64, 10); // floor slab band
  g.fillStyle = '#9aa1a8'; g.fillRect(6, 30, 52, 76); // frame
  const grad = g.createLinearGradient(0, 32, 0, 104);
  grad.addColorStop(0, style.glass); grad.addColorStop(1, '#6f8ba3');
  g.fillStyle = grad; g.fillRect(9, 33, 46, 70);
  g.fillStyle = '#9aa1a8'; g.fillRect(31, 33, 2, 70); // mullion
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / 1.8, 1 / floorHeight);
  tex.offset.y = -1 / floorHeight; // side UVs are v = 1 - z; this puts the slab bands on the floor lines
  tex.anisotropy = 8;
  return tex;
}
