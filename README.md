# EFS Campus 3D

A geo-accurate, "Google Earth"-style 3D model of the FH Dortmund campus at Emil-Figge-Straße 38–44,
built with Three.js. It covers 600 × 600 m around the FH buildings, using real OSM footprints, LoD2
roofs, DGM terrain and an NRW aerial photo. The FH buildings have detailed facades and can be
entered.

**Live:** https://saeed-mh.github.io/FH-Dortmund-3D/ (rebuilt automatically on every push to `main`)

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # static site in dist/ (about 4 MB, no external requests)
npm run fetch-geodata  # re-bake public/data/ from OSM + Geobasis NRW (dev time only)
```

**Controls:** drag to pan, right-drag or two fingers to orbit, scroll to zoom. Click a building to
select it. "Enter building" opens its floors. The compass resets to north and ⌂ shows the whole
campus. Esc leaves a building.

- [docs/geodata.md](docs/geodata.md): data sources, licences, coordinate system, the prep pipeline
- [docs/milestones.md](docs/milestones.md): milestone plan (M0 = geodata and real-location model)

Data: © OpenStreetMap contributors (ODbL) · Geobasis NRW (Datenlizenz Deutschland – Zero 2.0).
