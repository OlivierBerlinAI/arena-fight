/**
 * HP bar: a camera-facing sprite pair (dark background + left-anchored fill that
 * shades green→red as it drains). Used above mechs, robots and turrets.
 */
import * as THREE from 'three';

export class HpBar {
  readonly group = new THREE.Group();
  private readonly bg: THREE.Sprite;
  private readonly fg: THREE.Sprite;
  private readonly fgMat: THREE.SpriteMaterial;
  private readonly width: number;

  constructor(width: number, height = 0.18) {
    this.width = width;
    const bgMat = new THREE.SpriteMaterial({ color: 0x10161f, depthTest: false, transparent: true, opacity: 0.85 });
    this.bg = new THREE.Sprite(bgMat);
    this.bg.scale.set(width, height, 1);
    this.bg.renderOrder = 20;
    this.fgMat = new THREE.SpriteMaterial({ color: 0x4ade80, depthTest: false });
    this.fg = new THREE.Sprite(this.fgMat);
    this.fg.renderOrder = 21;
    this.fg.scale.set(width, height * 0.7, 1);
    this.group.add(this.bg, this.fg);
  }

  set(frac: number): void {
    const f = Math.min(1, Math.max(0, frac));
    if (f <= 0.001) {
      this.fg.visible = false;
      return;
    }
    this.fg.visible = true;
    this.fg.scale.x = this.width * f;
    // keep the fill's left edge pinned to the bar's left edge
    this.fg.center.set(0.5 / f, 0.5);
    this.fgMat.color.setHSL(0.33 * f, 0.85, 0.55);
  }

  dispose(): void {
    this.bg.material.dispose();
    this.fgMat.dispose();
  }
}
