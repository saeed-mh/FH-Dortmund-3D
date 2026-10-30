import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Google-Earth-style aerial orbit: drag to pan over the ground, right-drag/two fingers to orbit,
 * wheel to zoom. The orbit target is kept inside the campus bounds; flyTo animates smoothly.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private flight: null | { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number; dur: number } = null;

  constructor(dom: HTMLElement, private halfSize: number) {
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 5000);
    const c = (this.controls = new OrbitControls(this.camera, dom));
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.screenSpacePanning = false; // pan along the ground, like a map
    c.minDistance = 8;
    c.maxDistance = halfSize * 2.6;
    c.maxPolarAngle = THREE.MathUtils.degToRad(84);
    c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    c.zoomToCursor = true;
    this.home(false);
  }

  /** The overview: whole campus, looking north. */
  home(animate = true) {
    const target = new THREE.Vector3(0, 0, 0);
    const d = this.halfSize * 2.1;
    const pos = new THREE.Vector3(0, d * Math.cos(0.85), d * Math.sin(0.85));
    if (animate) this.flyTo(target, pos);
    else {
      this.controls.target.copy(target);
      this.camera.position.copy(pos);
      this.controls.update();
    }
  }

  /** Fly so that `target` is centred at `distance`, keeping the current heading. */
  flyToPoint(target: THREE.Vector3, distance: number, polarDeg = 52) {
    const azimuth = this.controls.getAzimuthalAngle();
    const polar = THREE.MathUtils.degToRad(polarDeg);
    const offset = new THREE.Vector3(Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), Math.sin(polar) * Math.cos(azimuth)).multiplyScalar(distance);
    this.flyTo(target, target.clone().add(offset));
  }

  flyTo(target: THREE.Vector3, position: THREE.Vector3, dur = 1400) {
    this.flight = {
      from: [this.controls.target.clone(), this.camera.position.clone()],
      to: [target.clone(), position.clone()],
      t0: performance.now(),
      dur,
    };
  }

  /** Rotates the view back to north-up. */
  faceNorth() {
    const t = this.controls.target;
    const off = this.camera.position.clone().sub(t);
    const horizontal = Math.hypot(off.x, off.z);
    this.flyTo(t.clone(), new THREE.Vector3(t.x, t.y + off.y, t.z + horizontal), 700);
  }

  get heading() {
    return this.controls.getAzimuthalAngle();
  }

  update(now: number) {
    if (this.flight) {
      const f = this.flight;
      const k = Math.min(1, (now - f.t0) / f.dur);
      const e = ease(k);
      // arc up a little so long flights read as flights, not slides
      const lift = Math.sin(Math.PI * k) * Math.min(120, f.from[0].distanceTo(f.to[0]) * 0.35);
      this.controls.target.lerpVectors(f.from[0], f.to[0], e);
      this.camera.position.lerpVectors(f.from[1], f.to[1], e);
      this.camera.position.y += lift;
      if (k >= 1) this.flight = null;
    }
    this.controls.update();
    // keep the orbit target over the campus
    const t = this.controls.target;
    const cx = THREE.MathUtils.clamp(t.x, -this.halfSize, this.halfSize) - t.x;
    const cz = THREE.MathUtils.clamp(t.z, -this.halfSize, this.halfSize) - t.z;
    if (cx || cz) {
      t.x += cx; t.z += cz;
      this.camera.position.x += cx; this.camera.position.z += cz;
    }
    t.y = THREE.MathUtils.clamp(t.y, -20, 60);
    if (this.camera.position.y < t.y + 2) this.camera.position.y = t.y + 2;
  }

  get flying() {
    return !!this.flight;
  }
}
