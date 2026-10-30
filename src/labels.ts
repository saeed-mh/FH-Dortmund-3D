import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { CampusData, Label } from './data';
import type { Terrain } from './geo';

const ICON: Record<string, string> = { fh: '', tu: 'TU', food: '☕', rail: 'S', hbahn: 'H', bus: 'H', building: '', 'fh-site': '' };

/** Landmark labels pinned in 3D, plus edge pointers for landmarks outside the model. */
export class Labels {
  readonly renderer = new CSS2DRenderer();
  readonly group = new THREE.Group();
  private items: { obj: CSS2DObject; label: Label }[] = [];
  private roomGroup = new THREE.Group();
  onSelectBuilding: (id: string) => void = () => {};
  onSelectRoom: (id: string) => void = () => {};

  constructor(data: CampusData, terrain: Terrain, host: HTMLElement) {
    this.renderer.domElement.className = 'labels-layer';
    host.appendChild(this.renderer.domElement);
    for (const l of data.labels.inArea) {
      const el = document.createElement('div');
      el.className = `label label-${l.kind}`;
      const icon = ICON[l.kind];
      el.innerHTML = `${icon ? `<span class="label-icon">${icon}</span>` : ''}<span class="label-text"></span>`;
      el.querySelector('.label-text')!.textContent = l.text;
      if (l.sub && l.sub !== l.text) {
        const sub = document.createElement('span');
        sub.className = 'label-sub';
        sub.textContent = l.sub;
        el.appendChild(sub);
      }
      if (l.building) {
        el.classList.add('clickable');
        el.addEventListener('click', () => this.onSelectBuilding(l.building!));
      }
      const obj = new CSS2DObject(el);
      const ground = terrain.heightAt(l.x, l.y);
      obj.position.set(l.x, l.building ? l.z : ground + l.z, -l.y);
      this.group.add(obj);
      this.items.push({ obj, label: l });
    }
    // landmarks beyond the model: a pointer on the edge of the area, in their direction
    const ext = data.meta.bounds.extent - 6;
    for (const p of data.labels.offArea) {
      const k = ext / Math.max(Math.abs(p.x), Math.abs(p.y));
      const x = p.x * k, y = p.y * k;
      const el = document.createElement('div');
      el.className = `label label-pointer label-${p.kind}`;
      const deg = (Math.atan2(p.x, p.y) * 180) / Math.PI;
      el.innerHTML = `<span class="pointer-arrow" style="--bearing:${deg}deg">➤</span><span class="label-text"></span><span class="label-sub">${p.distance} m</span>`;
      el.querySelector('.label-text')!.textContent = p.text;
      el.title = `${p.text} – ${p.distance} m from the campus centre, outside the model`;
      const obj = new CSS2DObject(el);
      obj.position.set(x, terrain.heightAt(x, y) + 6, -y);
      obj.userData.pointer = true;
      this.group.add(obj);
    }
    this.group.add(this.roomGroup);
  }

  setSize(w: number, h: number) {
    this.renderer.setSize(w, h);
  }

  /** Hides lower-priority labels as the camera pulls back, to keep the overview readable. */
  update(camera: THREE.Camera, distance: number, hiddenBuilding: string | null) {
    for (const { obj, label } of this.items) {
      const maxPriority = distance > 700 ? 1 : distance > 380 ? 2 : 3;
      obj.visible = label.priority <= maxPriority && label.building !== hiddenBuilding;
    }
    // the bearing arrows rotate with the view
    const heading = (camera as THREE.PerspectiveCamera).getWorldDirection(new THREE.Vector3());
    const rot = (-Math.atan2(heading.x, -heading.z) * 180) / Math.PI;
    for (const o of this.group.children) if (o.userData.pointer) ((o as CSS2DObject).element as HTMLElement).style.setProperty('--view', `${rot}deg`);
  }

  setRoomLabels(rooms: { id: string; text: string; position: THREE.Vector3 }[]) {
    for (const o of [...this.roomGroup.children]) o.removeFromParent();
    for (const r of rooms) {
      const el = document.createElement('div');
      el.className = 'label label-room clickable';
      el.textContent = r.text;
      el.addEventListener('click', () => this.onSelectRoom(r.id));
      const obj = new CSS2DObject(el);
      obj.position.copy(r.position);
      this.roomGroup.add(obj);
    }
  }

  setVisible(v: boolean) {
    this.group.visible = v;
    this.renderer.domElement.style.display = v ? '' : 'none';
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer.render(scene, camera);
  }
}
