// Types and loaders for the baked files in public/data (written by scripts/fetch-geodata).
// All x/y values are local metres (x = east, y = north) around meta.origin; see docs/geodata.md.

export type XY = [number, number];
export type Ring = XY[];
export type Polygon = Ring[]; // [outer, ...holes]

export interface Meta {
  generatedAt: string;
  centre: { lat: number; lon: number };
  crs: string;
  origin: { e: number; n: number };
  baseElevation: number | null;
  bounds: { halfSize: number; margin: number; extent: number };
  terrain: null | { file: string; size: number; cell: number; minX: number; maxY: number; minHeight: number; maxHeight: number };
  ortho: null | { file: string; size: number; minX: number; minY: number; maxX: number; maxY: number };
  lod2: null | { file: string; buildings: number };
  attribution: string[];
}

export interface Entrance {
  x: number;
  y: number;
  osm: string | null;
  assumed: boolean;
  type: string;
  ref: string | null;
  wheelchair: string | null;
}

export interface Building {
  id: string;
  name: string | null;
  address: string | null;
  type: string;
  operator: string | null;
  enterable: boolean;
  key: string | null;
  short: string | null;
  label: string | null;
  footprint: Polygon[];
  area: number;
  centroid: XY;
  base: number; // ground-floor level, metres above meta.baseElevation
  groundMin: number; // lowest terrain point under the footprint
  height: number;
  heightSource: string;
  minHeight: number;
  levels: number;
  levelsSource: string;
  floorHeight: number;
  roofShape: string | null;
  entrances: Entrance[];
  lod2: number[];
  render: 'detailed' | 'lod2' | 'extrude';
}

export interface Lod2Info {
  gmlId: string;
  osm: string | null;
  height: number;
  roofType: string | null;
}

export interface BuildingsFile {
  buildings: Building[];
  lod2: null | {
    file: string;
    layout: Record<string, { offset: number; length: number }>;
    buildings: Lod2Info[];
  };
}

export interface Road {
  id: string;
  type: string;
  name: string | null;
  width: number;
  bridge: boolean;
  tunnel: boolean;
  line: XY[];
}

export interface Area {
  id: string;
  class: 'campus' | 'farmland' | 'construction' | 'grass' | 'scrub' | 'forest' | 'pitch' | 'water' | 'paved';
  polygon: Polygon;
}

export interface MapFile {
  roads: Road[];
  areas: Area[];
  hbahn: { id: string; name: string; line: XY[] }[];
  points: {
    trees: [number, number, number, number, number][]; // x, y, height (0 = unknown), crown diameter, needleleaved
    generatedTrees: XY[];
    benches: [number, number, number][];
    bikeParking: [number, number, number][];
    busStops: { x: number; y: number; name: string | null; shelter: boolean }[];
    parking: { x: number; y: number; name: string | null }[];
    stations: { x: number; y: number; name: string | null; kind: 'rail' | 'hbahn' }[];
  };
}

export interface Label {
  text: string;
  sub?: string;
  kind: 'fh' | 'tu' | 'building' | 'food' | 'rail' | 'hbahn' | 'bus' | 'fh-site';
  x: number;
  y: number;
  z: number;
  building?: string;
  priority: number;
}

export interface LabelsFile {
  inArea: Label[];
  offArea: { text: string; kind: string; x: number; y: number; distance: number }[];
}

export interface Room {
  id: string;
  number: string;
  floor: number;
  type: 'info' | 'wc' | 'lecture' | 'lab' | 'seminar' | 'office';
  area: number;
  centroid: XY;
  polygon: Polygon;
}

export interface Interior {
  buildingId: string;
  key: string;
  floors: number;
  floorHeight: number;
  angle: number;
  generated: boolean;
  note: string;
  entrances: Entrance[];
  corridors: Polygon[];
  stairs: Polygon[];
  rooms: Room[];
}

export interface CampusData {
  meta: Meta;
  buildings: BuildingsFile;
  map: MapFile;
  labels: LabelsFile;
  interiors: Interior[];
  terrain: Uint16Array | null;
  lod2: ArrayBuffer | null;
  ortho: HTMLImageElement | null;
}

const url = (file: string) => `${import.meta.env.BASE_URL}data/${file}`;

async function json<T>(file: string): Promise<T> {
  const res = await fetch(url(file));
  if (!res.ok) throw new Error(`Missing ${file} – run "npm run fetch-geodata" first`);
  return res.json() as Promise<T>;
}

async function binary(file: string): Promise<ArrayBuffer> {
  const res = await fetch(url(file));
  if (!res.ok) throw new Error(`Missing ${file}`);
  return res.arrayBuffer();
}

function image(file: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Missing ${file}`));
    img.src = url(file);
  });
}

export async function loadCampus(): Promise<CampusData> {
  const meta = await json<Meta>('meta.json');
  const [buildings, map, labels, interiors, terrain, lod2, ortho] = await Promise.all([
    json<BuildingsFile>('buildings.json'),
    json<MapFile>('map.json'),
    json<LabelsFile>('labels.json'),
    json<Interior[]>('interiors.json'),
    meta.terrain ? binary(meta.terrain.file).then((b) => new Uint16Array(b)) : Promise.resolve(null),
    meta.lod2 ? binary(meta.lod2.file) : Promise.resolve(null),
    meta.ortho ? image(meta.ortho.file) : Promise.resolve(null),
  ]);
  return { meta, buildings, map, labels, interiors, terrain, lod2, ortho };
}
