import * as THREE from 'three';
import type { Building, CampusData, Interior, Polygon, Room } from '../data';
import { ringToShape } from '../geo';

export const ROOM_COLOURS: Record<Room['type'], string> = {
  office: '#e9e1cf',
  seminar: '#cfe0f0',
  lab: '#d8ecd2',
  lecture: '#f2d4c4',
  wc: '#dcd6ea',
  info: '#ffe9a8',
};

/**
 * Renders one floor of an enterable building: slab, corridors, stairs, coloured room floors and
 * walls along every room outline. Built lazily per building/floor and cached.
 */
export class Interiors {
  readonly group = new THREE.Group();
  readonly byBuilding = new Map<string, Interior>();
  private cache = new Map<string, THREE.Group>();
  private highlight: THREE.Mesh | null = null;

  constructor(data: CampusData) {
    for (const i of data.interiors) this.byBuilding.set(i.buildingId, i);
  }

  roomById(id: string) {
    for (const i of this.byBuilding.values()) {
      const r = i.rooms.find((r) => r.id === id);
      if (r) return { interior: i, room: r };
    }
    return null;
  }

  show(b: Building | null, floor: number) {
    for (const g of this.cache.values()) g.visible = false;
    this.setHighlight(null);
    if (!b) return;
    const interior = this.byBuilding.get(b.id);
    if (!interior) return;
    const key = `${b.id}#${floor}`;
    let g = this.cache.get(key);
    if (!g) {
      g = buildFloor(b, interior, floor);
      this.cache.set(key, g);
      this.group.add(g);
    }
    g.visible = true;
  }

  /** Room meshes of the visible floor, for picking. */
  pickables() {
    const out: THREE.Object3D[] = [];
    for (const g of this.cache.values()) if (g.visible) g.traverse((o) => o.userData.roomId && out.push(o));
    return out;
  }

  setHighlight(room: Room | null, b?: Building) {
    if (this.highlight) {
      this.highlight.removeFromParent();
      this.highlight.geometry.dispose();
      this.highlight = null;
    }
    if (!room || !b) return;
    const y = b.base + room.floor * b.floorHeight + 0.12;
    const g = flatGeometry(room.polygon, y);
    this.highlight = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#ff7a1a', transparent: true, opacity: 0.55, depthWrite: false }));
    this.group.add(this.highlight);
  }
}

function buildFloor(b: Building, interior: Interior, floor: number) {
  const g = new THREE.Group();
  const y = b.base + floor * b.floorHeight;
  const wallH = b.floorHeight * 0.85;

  const slab = new THREE.MeshStandardMaterial({ color: '#b9b4ab', roughness: 1 });
  for (const p of b.footprint) g.add(new THREE.Mesh(flatGeometry(p, y - 0.05, 0.25), slab));
  const corridorMat = new THREE.MeshStandardMaterial({ color: '#f4f2ee', roughness: 1 });
  for (const p of interior.corridors) g.add(new THREE.Mesh(flatGeometry(p, y + 0.03), corridorMat));
  const stairMat = new THREE.MeshStandardMaterial({ color: '#8a96a3', roughness: 1 });
  for (const p of interior.stairs) g.add(new THREE.Mesh(flatGeometry(p, y + 0.04), stairMat));

  const wallSegs: number[] = [];
  const mats = new Map<string, THREE.Material>();
  for (const r of interior.rooms.filter((r) => r.floor === floor)) {
    const colour = ROOM_COLOURS[r.type];
    if (!mats.has(colour)) mats.set(colour, new THREE.MeshStandardMaterial({ color: colour, roughness: 1 }));
    const m = new THREE.Mesh(flatGeometry(r.polygon, y + 0.05), mats.get(colour)!);
    m.userData.roomId = r.id;
    g.add(m);
    for (const ring of r.polygon) for (let i = 0; i < ring.length; i++) wallSegs.push(...ring[i], ...ring[(i + 1) % ring.length]);
  }
  // outer walls follow the real footprint
  for (const p of b.footprint) for (const ring of p) for (let i = 0; i < ring.length; i++) wallSegs.push(...ring[i], ...ring[(i + 1) % ring.length]);
  g.add(walls(wallSegs, y, wallH));

  // stairs: a few step blocks so they read as stairs from above
  const stepMat = new THREE.MeshStandardMaterial({ color: '#6f7b87', roughness: 1 });
  for (const p of interior.stairs) {
    const ring = p[0];
    const cx = ring.reduce((a, q) => a + q[0], 0) / ring.length, cy = ring.reduce((a, q) => a + q[1], 0) / ring.length;
    for (let k = 0; k < 4; k++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.3 * (k + 1), 0.8), stepMat);
      step.position.set(cx, y + 0.15 * (k + 1), -cy + (k - 1.5) * 0.85);
      step.rotation.y = interior.angle;
      g.add(step);
    }
  }
  return g;
}

/** Thin double-sided wall quads for a list of segments [x1, y1, x2, y2, ...]. */
function walls(segs: number[], y: number, h: number) {
  const pos: number[] = [];
  for (let i = 0; i < segs.length; i += 4) {
    const [x1, y1, x2, y2] = segs.slice(i, i + 4);
    pos.push(x1, y, -y1, x2, y, -y2, x2, y + h, -y2, x1, y, -y1, x2, y + h, -y2, x1, y + h, -y1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#fbfaf7', roughness: 0.9, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }));
}

function flatGeometry(p: Polygon, y: number, depth = 0) {
  const shape = ringToShape(p[0], p.slice(1));
  const geo = depth ? new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }) : new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, depth ? y - depth : y, 0);
  return geo;
}
