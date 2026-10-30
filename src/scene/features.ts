import * as THREE from 'three';
import type { CampusData } from '../data';
import { hash01, type Terrain } from '../geo';

const tmp = new THREE.Object3D();

/** Trees, benches, bike parking, bus stops, the H-Bahn and FH entrance markers. */
export class Features {
  readonly trees = new THREE.Group();
  readonly furniture = new THREE.Group();
  readonly hbahn = new THREE.Group();
  readonly entrances = new THREE.Group();

  constructor(private data: CampusData, private terrain: Terrain) {
    this.buildTrees();
    this.buildFurniture();
    this.buildHBahn();
    this.buildEntrances();
  }

  private buildTrees() {
    const { trees, generatedTrees } = this.data.map.points;
    const all: { x: number; y: number; h: number; crown: number; conifer: boolean }[] = [];
    for (const [x, y, h, crown, needle] of trees) {
      const r = hash01(x, y);
      const height = h || 8 + r * 7;
      all.push({ x, y, h: height, crown: crown || height * (0.45 + r * 0.15), conifer: needle === 1 });
    }
    for (const [x, y] of generatedTrees) {
      const r = hash01(x, y);
      all.push({ x, y, h: 7 + r * 9, crown: 4 + r * 4, conifer: r > 0.85 });
    }
    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 1, 6).translate(0, 0.5, 0);
    const leafGeo = new THREE.IcosahedronGeometry(0.5, 1);
    const coneGeo = new THREE.ConeGeometry(0.5, 1, 8).translate(0, 0.5, 0);
    const trunk = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#6b4f3a', roughness: 1 }), all.length);
    const broad = all.filter((t) => !t.conifer), conif = all.filter((t) => t.conifer);
    const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ color: '#5f8f4a', roughness: 1, flatShading: true }), broad.length);
    const cones = new THREE.InstancedMesh(coneGeo, new THREE.MeshStandardMaterial({ color: '#3f6b45', roughness: 1, flatShading: true }), conif.length);
    const colour = new THREE.Color();
    all.forEach((t, i) => {
      const g = this.terrain.heightAt(t.x, t.y);
      tmp.position.set(t.x, g, -t.y);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.set(1, t.h * 0.45, 1);
      tmp.updateMatrix();
      trunk.setMatrixAt(i, tmp.matrix);
    });
    broad.forEach((t, i) => {
      const g = this.terrain.heightAt(t.x, t.y);
      tmp.position.set(t.x, g + t.h - t.crown * 0.45, -t.y);
      tmp.rotation.set(0, hash01(t.y, t.x) * 6.28, 0);
      tmp.scale.set(t.crown, t.crown * 0.9, t.crown);
      tmp.updateMatrix();
      leaves.setMatrixAt(i, tmp.matrix);
      leaves.setColorAt(i, colour.setHSL(0.27 + hash01(t.x, t.y) * 0.06, 0.38, 0.32 + hash01(t.y, t.y) * 0.1));
    });
    conif.forEach((t, i) => {
      const g = this.terrain.heightAt(t.x, t.y);
      tmp.position.set(t.x, g + t.h * 0.25, -t.y);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.set(t.crown * 0.7, t.h * 0.8, t.crown * 0.7);
      tmp.updateMatrix();
      cones.setMatrixAt(i, tmp.matrix);
    });
    for (const m of [trunk, leaves, cones]) {
      m.castShadow = true;
      this.trees.add(m);
    }
  }

  private buildFurniture() {
    const { benches, bikeParking, busStops } = this.data.map.points;
    const metal = new THREE.MeshStandardMaterial({ color: '#5d6166', roughness: 0.6, metalness: 0.4 });
    const wood = new THREE.MeshStandardMaterial({ color: '#9a7350', roughness: 0.9 });
    const bench = new THREE.InstancedMesh(new THREE.BoxGeometry(1.8, 0.45, 0.6).translate(0, 0.225, 0), wood, benches.length);
    benches.forEach(([x, y, dir], i) => {
      tmp.position.set(x, this.terrain.heightAt(x, y), -y);
      tmp.rotation.set(0, (-dir * Math.PI) / 180, 0);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      bench.setMatrixAt(i, tmp.matrix);
    });
    const racks = new THREE.InstancedMesh(new THREE.BoxGeometry(4, 0.9, 1.8).translate(0, 0.45, 0), metal, bikeParking.length);
    bikeParking.forEach(([x, y, cap], i) => {
      tmp.position.set(x, this.terrain.heightAt(x, y), -y);
      tmp.rotation.set(0, hash01(x, y) * Math.PI, 0);
      tmp.scale.set(Math.max(0.5, Math.min(3, (cap || 10) / 10)), 1, 1);
      tmp.updateMatrix();
      racks.setMatrixAt(i, tmp.matrix);
    });
    this.furniture.add(bench, racks);
    // bus stops: shelter + yellow-green "H" sign pole
    const sign = new THREE.MeshStandardMaterial({ color: '#f2c200', roughness: 0.5 });
    const glass = new THREE.MeshStandardMaterial({ color: '#9fc1d6', transparent: true, opacity: 0.55, roughness: 0.2 });
    for (const s of busStops) {
      const g = this.terrain.heightAt(s.x, s.y);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6), metal);
      pole.position.set(s.x, g + 1.3, -s.y);
      const plate = new THREE.Mesh(new THREE.CircleGeometry(0.3, 16), sign);
      plate.position.set(s.x, g + 2.6, -s.y + 0.06);
      this.furniture.add(pole, plate);
      if (s.shelter) {
        const shelter = new THREE.Mesh(new THREE.BoxGeometry(3.5, 2.4, 1.4), glass);
        shelter.position.set(s.x + 1.5, g + 1.2, -s.y);
        this.furniture.add(shelter);
      }
    }
  }

  // The H-Bahn is a suspended monorail: a box girder about 10 m up on pillars, cabins hanging below.
  private buildHBahn() {
    const girder = new THREE.MeshStandardMaterial({ color: '#8d969e', roughness: 0.6, metalness: 0.3 });
    const geos: THREE.Matrix4[] = [];
    const pillars: THREE.Vector3[] = [];
    const H = 10;
    for (const way of this.data.map.hbahn) {
      let acc = 0;
      for (let i = 1; i < way.line.length; i++) {
        const [ax, ay] = way.line[i - 1], [bx, by] = way.line[i];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 0.01) continue;
        const ga = this.terrain.heightAt(ax, ay), gb = this.terrain.heightAt(bx, by);
        const top = Math.max(ga, gb) + H;
        tmp.position.set((ax + bx) / 2, top, -(ay + by) / 2);
        tmp.rotation.set(0, Math.atan2(by - ay, bx - ax), 0);
        tmp.scale.set(len + 0.3, 1, 1);
        tmp.updateMatrix();
        geos.push(tmp.matrix.clone());
        // a pillar roughly every 30 m
        for (acc += len; acc > 30; acc -= 30) {
          const t = 1 - (acc - 30) / len;
          const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
          pillars.push(new THREE.Vector3(px, this.terrain.heightAt(px, py), -py));
        }
      }
    }
    const beam = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1.1, 0.9), girder, geos.length);
    geos.forEach((m, i) => beam.setMatrixAt(i, m));
    const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.35, 0.45, 1, 8).translate(0, 0.5, 0), girder, pillars.length);
    pillars.forEach((p, i) => {
      tmp.position.copy(p);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.set(1, H + 0.5, 1);
      tmp.updateMatrix();
      posts.setMatrixAt(i, tmp.matrix);
    });
    beam.castShadow = posts.castShadow = true;
    this.hbahn.add(beam, posts);
  }

  private buildEntrances() {
    const real = new THREE.MeshStandardMaterial({ color: '#2e9e5b', emissive: '#145c31', roughness: 0.5 });
    const assumed = new THREE.MeshStandardMaterial({ color: '#e08a1e', emissive: '#6b3d06', roughness: 0.5 });
    const geo = new THREE.ConeGeometry(0.6, 1.4, 4).rotateX(Math.PI);
    for (const b of this.data.buildings.buildings.filter((b) => b.enterable)) {
      for (const e of b.entrances) {
        const m = new THREE.Mesh(geo, e.assumed ? assumed : real);
        m.position.set(e.x, this.terrain.heightAt(e.x, e.y) + 3.4, -e.y);
        m.userData.entrance = { building: b.id, ...e };
        this.entrances.add(m);
      }
    }
  }
}
