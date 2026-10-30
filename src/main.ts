import * as THREE from 'three';
import './style.css';
import { CameraRig } from './camera';
import { loadCampus, type Building, type CampusData, type Room } from './data';
import { Terrain, bboxOf } from './geo';
import { Labels } from './labels';
import { Buildings } from './scene/buildings';
import { Features } from './scene/features';
import { Ground } from './scene/ground';
import { Interiors, ROOM_COLOURS } from './scene/interiors';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

class App {
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private scene = new THREE.Scene();
  private rig: CameraRig;
  private terrain: Terrain;
  private ground: Ground;
  private buildings: Buildings;
  private features: Features;
  private interiors: Interiors;
  private labels: Labels;
  private raycaster = new THREE.Raycaster();

  private selected: Building | null = null;
  private inside: Building | null = null;
  private floor = 0;
  private selectedRoom: Room | null = null;

  constructor(private data: CampusData) {
    const host = $('#viewport');
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    const half = data.meta.bounds.halfSize;
    this.rig = new CameraRig(this.renderer.domElement, half);
    this.terrain = new Terrain(data.meta, data.terrain);
    this.scene.background = new THREE.Color('#cfe0ee');
    this.scene.fog = new THREE.Fog('#cfe0ee', half * 3, half * 7);
    this.addLights();

    this.ground = new Ground(data, this.terrain);
    this.buildings = new Buildings(data);
    this.features = new Features(data, this.terrain);
    this.interiors = new Interiors(data);
    this.scene.add(this.ground.mesh, this.buildings.group, this.features.trees, this.features.furniture, this.features.hbahn, this.features.entrances, this.interiors.group);
    this.addSurroundings();

    this.labels = new Labels(data, this.terrain, host);
    this.scene.add(this.labels.group);
    this.labels.onSelectBuilding = (id) => this.selectBuilding(id, true);
    this.labels.onSelectRoom = (id) => this.selectRoom(id);

    this.bindUi();
    this.resize();
    addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  private addLights() {
    this.scene.add(new THREE.HemisphereLight('#eaf3ff', '#8a8576', 1.4));
    const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
    sun.position.set(-260, 420, 180); // south-west afternoon sun
    sun.castShadow = true;
    const s = this.data.meta.bounds.extent;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 50, far: 1200 });
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    this.scene.add(sun);
  }

  /** A muted ground ring beyond the baked area so the model does not float in the void. */
  private addSurroundings() {
    const ext = this.data.meta.bounds.extent;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(ext * Math.SQRT2, ext * 9, 4, 1, Math.PI / 4).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#c9cdbf' }),
    );
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(ext * 2.84, ext * 2.84).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#c9cdbf' }));
    ring.position.y = skirt.position.y = this.terrain.heightAt(0, 0) - 18;
    this.scene.add(ring, skirt);
  }

  // ---------------------------------------------------------------- loop

  private frame(now: number) {
    this.rig.update(now);
    const cam = this.rig.camera;
    $('#needle').style.transform = `rotate(${THREE.MathUtils.radToDeg(this.rig.heading)}deg)`;
    this.labels.update(cam, cam.position.distanceTo(this.rig.controls.target), this.inside?.id ?? null);
    this.renderer.render(this.scene, cam);
    this.labels.render(this.scene, cam);
  }

  private resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- selection

  private pickAt(ev: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.rig.camera);
    if (this.inside) {
      const hit = this.raycaster.intersectObjects(this.interiors.pickables(), false)[0];
      if (hit) return this.selectRoom(hit.object.userData.roomId);
    }
    const targets = this.buildings.pickables.filter((o) => o.visible && (o.parent?.visible ?? true));
    const hit = this.raycaster.intersectObjects(targets, true)[0];
    if (!hit) return;
    const info = this.buildings.pick(hit);
    if (info?.building) this.selectBuilding(info.building.id, info.building.enterable);
    else if (info?.lod2Id) this.showUnmatched(info.lod2Id);
  }

  selectBuilding(id: string, fly: boolean) {
    const b = this.buildings.get(id);
    if (!b) return;
    if (this.inside && this.inside.id !== id) this.exitBuilding();
    this.selected = b;
    this.selectedRoom = null;
    this.interiors.setHighlight(null);
    if (fly) this.flyToBuilding(b);
    this.renderSelection();
  }

  private flyToBuilding(b: Building) {
    const pts = b.footprint.flatMap((p) => p[0]);
    const box = bboxOf(pts);
    const size = Math.max(box.w, box.h, b.height * 1.5);
    const target = new THREE.Vector3((box.x0 + box.x1) / 2, b.base + b.height * 0.4, -(box.y0 + box.y1) / 2);
    this.rig.flyToPoint(target, Math.max(45, size * 1.9), 55);
  }

  enterBuilding(b: Building) {
    this.inside = b;
    this.selected = b;
    this.floor = Math.min(this.floor, b.levels - 1);
    this.buildings.setShellGhost(b.id);
    this.showFloor(this.floor);
    const box = bboxOf(b.footprint.flatMap((p) => p[0]));
    const target = new THREE.Vector3((box.x0 + box.x1) / 2, b.base + this.floor * b.floorHeight, -(box.y0 + box.y1) / 2);
    this.rig.flyToPoint(target, Math.max(40, Math.max(box.w, box.h) * 1.5), 35);
    this.renderSelection();
  }

  exitBuilding() {
    this.inside = null;
    this.selectedRoom = null;
    this.buildings.setShellGhost(null);
    this.interiors.show(null, 0);
    this.labels.setRoomLabels([]);
    this.renderSelection();
  }

  private showFloor(f: number) {
    const b = this.inside!;
    this.floor = f;
    this.interiors.show(b, f);
    const interior = this.interiors.byBuilding.get(b.id)!;
    const y = b.base + f * b.floorHeight + 1.2;
    this.labels.setRoomLabels(
      interior.rooms
        .filter((r) => r.floor === f && r.area >= 14)
        .map((r) => ({ id: r.id, text: r.number, position: new THREE.Vector3(r.centroid[0], y, -r.centroid[1]) })),
    );
    if (this.selectedRoom && this.selectedRoom.floor === f) this.interiors.setHighlight(this.selectedRoom, b);
  }

  selectRoom(id: string) {
    const found = this.interiors.roomById(id);
    if (!found) return;
    const b = this.buildings.get(found.interior.buildingId)!;
    if (this.inside?.id !== b.id) {
      this.floor = found.room.floor;
      this.enterBuilding(b);
    }
    this.selectedRoom = found.room;
    this.showFloor(found.room.floor);
    this.interiors.setHighlight(found.room, b);
    const [x, y] = found.room.centroid;
    this.rig.flyToPoint(new THREE.Vector3(x, b.base + found.room.floor * b.floorHeight, -y), 34, 40);
    this.renderSelection();
  }

  private showUnmatched(gmlId: string) {
    this.selected = null;
    const el = $('#selection');
    el.hidden = false;
    el.innerHTML = `<h3>Building</h3><p class="muted">LoD2 model ${escapeHtml(gmlId)} (Geobasis NRW). No matching OSM building; not enterable.</p>`;
  }

  // ---------------------------------------------------------------- ui

  private renderSelection() {
    const el = $('#selection');
    const b = this.selected;
    if (!b) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const title = b.enterable ? `${b.short}${b.name ? ` · ${b.name}` : ''}` : b.name ?? b.address ?? 'Building';
    const ent = b.entrances.length
      ? `${b.entrances.length} (${b.entrances.filter((e) => e.assumed).length} assumed)`
      : '–';
    el.innerHTML = `
      <h3></h3>
      <p class="muted">${escapeHtml(b.address ?? '')}</p>
      <dl>
        <dt>Height</dt><dd>${b.height.toFixed(1)} m <span class="muted">(${escapeHtml(b.heightSource)})</span></dd>
        <dt>Floors</dt><dd>${b.levels} <span class="muted">(${escapeHtml(b.levelsSource)})</span></dd>
        <dt>Footprint</dt><dd>${Math.round(b.area)} m²</dd>
        ${b.enterable ? `<dt>Entrances</dt><dd>${ent}</dd>` : ''}
        <dt>Model</dt><dd>${b.render === 'lod2' ? 'LoD2 (Geobasis NRW)' : b.render === 'detailed' ? 'Detailed (FH)' : 'OSM extrusion'}</dd>
      </dl>
      <div class="row" id="sel-actions"></div>
      <div id="sel-floors"></div>`;
    el.querySelector('h3')!.textContent = title;
    const actions = el.querySelector('#sel-actions')!;
    if (!b.enterable) {
      actions.innerHTML = '<span class="muted">Not enterable</span>';
      return;
    }
    if (this.inside?.id === b.id) {
      actions.append(button('Leave building', () => this.exitBuilding(), 'secondary'));
      const floors = el.querySelector('#sel-floors')!;
      const row = document.createElement('div');
      row.className = 'floors';
      for (let f = b.levels - 1; f >= 0; f--) {
        const btn = button(f === 0 ? 'EG' : String(f), () => {
          this.selectedRoom = null;
          this.showFloor(f);
          this.renderSelection();
        });
        btn.title = f === 0 ? 'Ground floor (Erdgeschoss)' : `Floor ${f}`;
        if (f === this.floor) btn.classList.add('on');
        row.append(btn);
      }
      floors.append(row);
      const legend = document.createElement('div');
      legend.className = 'legend';
      legend.innerHTML = Object.entries(ROOM_COLOURS).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join('');
      floors.append(legend);
      if (this.selectedRoom) {
        const r = this.selectedRoom;
        const p = document.createElement('p');
        p.innerHTML = `<strong></strong> · ${r.type} · ${r.area} m²`;
        p.querySelector('strong')!.textContent = `Room ${r.number}`;
        floors.append(p);
      }
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = this.interiors.byBuilding.get(b.id)?.note ?? '';
      floors.append(note);
    } else {
      actions.append(button('Enter building', () => this.enterBuilding(b)));
      actions.append(button('Fly to', () => this.flyToBuilding(b), 'secondary'));
    }
  }

  private bindUi() {
    // FH building list
    const list = $('#fh-list');
    for (const b of this.data.buildings.buildings.filter((b) => b.enterable).sort((a, b) => (a.short ?? '').localeCompare(b.short ?? ''))) {
      const li = document.createElement('li');
      li.append(button('', () => this.selectBuilding(b.id, true)));
      li.querySelector('button')!.innerHTML = `<span></span><span class="meta">${b.levels} floors</span>`;
      li.querySelector('span')!.textContent = `${b.short}${b.name && b.name !== b.short ? ` · ${b.name}` : ''}`;
      list.append(li);
    }

    // search over buildings and rooms
    const results = $('#results');
    $<HTMLInputElement>('#search').addEventListener('input', (e) => {
      const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
      results.innerHTML = '';
      if (q.length < 2) return;
      const terms = q.split(/\s+/);
      const hits: { text: string; meta: string; go: () => void }[] = [];
      for (const b of this.data.buildings.buildings) {
        const hay = [b.short, b.name, b.address, b.label].filter(Boolean).join(' ').toLowerCase();
        if (terms.every((t) => hay.includes(t))) hits.push({ text: b.short ?? b.name ?? b.address ?? b.id, meta: b.enterable ? 'FH' : 'building', go: () => this.selectBuilding(b.id, true) });
      }
      for (const i of this.data.interiors) {
        const b = this.buildings.get(i.buildingId)!;
        for (const r of i.rooms) {
          const hay = `${b.short} ${b.key} ${r.number} ${r.type}`.toLowerCase();
          if (terms.every((t) => hay.includes(t))) hits.push({ text: `${b.short} · ${r.number}`, meta: r.type, go: () => this.selectRoom(r.id) });
        }
      }
      for (const h of hits.slice(0, 30)) {
        const li = document.createElement('li');
        const btn = button('', h.go);
        btn.innerHTML = '<span></span><span class="meta"></span>';
        btn.children[0].textContent = h.text;
        btn.children[1].textContent = h.meta;
        li.append(btn);
        results.append(li);
      }
    });

    // layers
    const groundBtns = document.querySelectorAll<HTMLButtonElement>('[data-ground]');
    groundBtns.forEach((btn) => {
      if (btn.dataset.ground === 'aerial' && !this.ground.hasAerial) btn.disabled = true;
      btn.addEventListener('click', () => {
        groundBtns.forEach((b) => b.classList.toggle('on', b === btn));
        this.ground.setMode(btn.dataset.ground as 'aerial' | 'map');
      });
    });
    if (!this.ground.hasAerial) {
      groundBtns.forEach((b) => b.classList.toggle('on', b.dataset.ground === 'map'));
      this.ground.setMode('map');
    }
    const layers: Record<string, (v: boolean) => void> = {
      labels: (v) => this.labels.setVisible(v),
      others: (v) => (this.buildings.others.visible = v),
      trees: (v) => (this.features.trees.visible = v),
      hbahn: (v) => (this.features.hbahn.visible = v),
      entrances: (v) => (this.features.entrances.visible = v),
    };
    document.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((cb) => cb.addEventListener('change', () => layers[cb.dataset.layer!](cb.checked)));

    // panel, compass, home
    const panel = $('#panel');
    $('#panel-toggle').addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      $('#panel-toggle').setAttribute('aria-expanded', String(!panel.classList.contains('collapsed')));
    });
    if (innerWidth < 640) panel.classList.add('collapsed');
    $('#compass').addEventListener('click', () => this.rig.faceNorth());
    $('#home').addEventListener('click', () => {
      this.exitBuilding();
      this.selected = null;
      this.renderSelection();
      this.rig.home();
    });

    // click (not drag) on the scene picks
    let down: { x: number; y: number } | null = null;
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) this.pickAt(e);
      down = null;
    });
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.inside) this.exitBuilding();
    });

    const footer = $('#attribution');
    footer.innerHTML = this.data.meta.attribution
      .map((a) => (a.includes('OpenStreetMap') ? `<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">${escapeHtml(a)}</a>` : escapeHtml(a)))
      .join(' · ');
  }
}

function button(text: string, onClick: () => void, variant = '') {
  const b = document.createElement('button');
  b.className = `btn ${variant}`;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

loadCampus()
  .then((data) => {
    new App(data);
    $('#loading').classList.add('done');
  })
  .catch((err) => {
    console.error(err);
    const el = $('#loading');
    el.classList.add('error');
    el.textContent = String(err.message ?? err);
  });
