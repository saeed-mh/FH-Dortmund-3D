import * as THREE from 'three';
import type { CampusData, Polygon } from '../data';
import type { Terrain } from '../geo';

const AREA_COLOURS: Record<string, string> = {
  campus: '#e4e2da',
  farmland: '#d9d3a6',
  construction: '#cfc4b0',
  grass: '#b9d39a',
  scrub: '#a6c48a',
  forest: '#8db67a',
  pitch: '#a8d3a0',
  water: '#a8cbe6',
  paved: '#d0cdc6',
};
const ROAD_COLOURS: Record<string, string> = {
  footway: '#f4efe6', path: '#efe6d2', cycleway: '#e8efe9', steps: '#f0d9c8', pedestrian: '#f1eee8',
  track: '#d9c9a8', service: '#ffffff', residential: '#ffffff', unclassified: '#ffffff', living_street: '#ffffff',
  tertiary: '#fff6c9', secondary: '#fde6b0', primary: '#fcd6a4',
};

/**
 * The ground: a DGM-displaced grid textured with either the aerial orthophoto or a map texture
 * rasterised from the OSM land-use polygons and roads.
 */
export class Ground {
  readonly mesh: THREE.Mesh;
  readonly hasAerial: boolean;
  private aerial: THREE.Texture | null = null;
  private map: THREE.Texture;
  private material: THREE.MeshStandardMaterial;

  constructor(data: CampusData, terrain: Terrain) {
    const ext = data.meta.bounds.extent;
    const seg = terrain.size - 1;
    const geo = new THREE.PlaneGeometry(ext * 2, ext * 2, seg, seg);
    geo.rotateX(-Math.PI / 2); // row 0 (north edge) ends up at -Z, matching the DGM grid
    const pos = geo.attributes.position as THREE.BufferAttribute;
    if (seg > 1) for (let j = 0; j <= seg; j++) for (let i = 0; i <= seg; i++) pos.setY(j * (seg + 1) + i, terrain.at(i, j));
    geo.computeVertexNormals();

    this.map = mapTexture(data);
    if (data.ortho) {
      const tex = new THREE.Texture(data.ortho);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.needsUpdate = true;
      this.aerial = tex;
    }
    this.hasAerial = !!this.aerial;
    this.material = new THREE.MeshStandardMaterial({ map: this.aerial ?? this.map, roughness: 1, metalness: 0 });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'ground';
    this.mesh.receiveShadow = true;
  }

  setMode(mode: 'aerial' | 'map') {
    this.material.map = mode === 'aerial' && this.aerial ? this.aerial : this.map;
    this.material.needsUpdate = true;
  }
}

function mapTexture(data: CampusData) {
  const size = 2048;
  const ext = data.meta.bounds.extent;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const s = size / (2 * ext);
  const px = (x: number) => (x + ext) * s;
  const py = (y: number) => (ext - y) * s;
  ctx.fillStyle = '#e9ecdf';
  ctx.fillRect(0, 0, size, size);

  const fillPolygon = (poly: Polygon) => {
    ctx.beginPath();
    for (const ring of poly) {
      ring.forEach(([x, y], i) => (i ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y))));
      ctx.closePath();
    }
    ctx.fill('evenodd');
  };
  for (const a of data.map.areas) {
    ctx.fillStyle = AREA_COLOURS[a.class] ?? '#e4e2da';
    fillPolygon(a.polygon);
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // casing pass, then fill pass, so junctions merge cleanly
  for (const pass of [0, 1]) {
    for (const r of data.map.roads) {
      if (r.tunnel) continue;
      ctx.strokeStyle = pass ? ROAD_COLOURS[r.type] ?? '#ffffff' : 'rgba(120,110,95,0.45)';
      ctx.lineWidth = Math.max(1.5, (r.width + (pass ? 0 : 0.8)) * s);
      ctx.beginPath();
      r.line.forEach(([x, y], i) => (i ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y))));
      ctx.stroke();
    }
  }
  // building footprints as soft shadows on the map
  ctx.fillStyle = 'rgba(150,140,128,0.55)';
  for (const b of data.buildings.buildings) for (const p of b.footprint) fillPolygon(p);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
