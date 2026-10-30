// Configuration for the one-off geodata prep script.
// Everything the script bakes is derived from these values; change them and re-run.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const OUT_DIR = path.join(ROOT, 'public', 'data');
export const CACHE_DIR = path.join(here, '.cache');

// Centre of the model. Verified 2026-10-30 with Nominatim: centroid of the OSM footprints of
// Emil-Figge-Strasse 38 (way 130871490), 40 (way 24580642), 42 (way 24551042), 44 (way 666943113)
// and kostBar 40a (way 95804177). The script re-checks this on every online run.
// Note: 51.4925 N / 7.4142 E (from the original brief) is the TU Mensa / H-Bahn "Campus Nord",
// about 420 m west of the FH buildings.
export const CENTRE = { lat: 51.49400, lon: 7.42020 };

// Square model area: HALF_SIZE metres each way from the centre, plus MARGIN for context.
// The camera is limited to HALF_SIZE; data is baked out to HALF_SIZE + MARGIN.
export const HALF_SIZE = 300;
export const MARGIN = 50;

// Projected CRS used for all baking. ETRS89 / UTM zone 32N (EPSG:25832) is the native CRS of the
// NRW geodata, so LoD2, DGM and DOP need no reprojection.
export const CRS = 'EPSG:25832';
export const CRS_DEF = '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs';

// Enterable FH buildings. `osm` is the OSM element of the outline; the rest of the FH complex is
// detected by address and reported so this list can be extended.
export const ENTERABLE = [
  { key: 'efs38', osm: 'way/130871490', short: 'EFS 38', label: 'FH Dortmund – EFS 38' },
  { key: 'efs38b', osm: 'way/208448125', short: 'EFS 38 · 2', label: 'FH Dortmund – EFS 38 (FH-Plus 2)' },
  { key: 'efs38c', osm: 'way/591790701', short: 'EFS 38 · 3', label: 'FH Dortmund – EFS 38 (FH-Plus 3)' },
  { key: 'efs40', osm: 'way/24580642', short: 'EFS 40', label: 'FH Dortmund – EFS 40' },
  { key: 'efs42', osm: 'way/24551042', short: 'EFS 42', label: 'FH Dortmund – EFS 42' },
  { key: 'efs44', osm: 'way/666943113', short: 'EFS 44', label: 'FH Dortmund – EFS 44' },
  { key: 'kostbar', osm: 'way/95804177', short: 'kostBar', label: 'kostBar / Auditorium' },
];
export const FH_STREET = 'Emil-Figge-Straße';
export const FH_HOUSENUMBERS = ['38', '38a', '38b', '40', '40a', '42', '44'];

// Building height fallbacks (brief: height tag, else levels x 3.2 m, else a default).
export const LEVEL_HEIGHT = 3.2;
export const DEFAULT_HEIGHT = 9.6;
export const DEFAULT_LEVELS = 3;

// Ground raster resolution and aerial image size.
export const TERRAIN_CELL = 2; // metres
export const ORTHO_SIZE = 4096; // pixels across the whole baked area
export const ORTHO_QUALITY = 72; // WebP quality

export const USER_AGENT = 'efs-campus-geodata-prep/1.0 (one-off dev script)';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
export const OSM_API_MAP = 'https://api.openstreetmap.org/api/0.6/map.json';
export const NOMINATIM = 'https://nominatim.openstreetmap.org';

export const NRW = {
  lod2Index: 'https://www.opengeodata.nrw.de/produkte/geobasis/3dg/lod2_gml/lod2_gml/',
  dgm1Index: 'https://www.opengeodata.nrw.de/produkte/geobasis/hm/dgm1_tiff/dgm1_tiff/',
  dopWms: 'https://www.wms.nrw.de/geobasis/wms_nw_dop',
  dopLayer: 'nw_dop_rgb',
  licence: 'Datenlizenz Deutschland – Zero – Version 2.0 (https://www.govdata.de/dl-de/zero-2-0)',
};

// Landmarks outside the camera bounds are shown as edge pointers ("Mensa → 380 m").
export const CONTEXT_RADIUS = 1200;
