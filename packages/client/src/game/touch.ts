/**
 * On-screen touch controls so the game is fully playable with no keyboard or
 * mouse. Two thumbs:
 *
 *   left  — a floating joystick (appears where you press in the left zone).
 *           Push to drive (up = forward, down = reverse) and tilt left/right to
 *           steer. Output is a unit-disc vector consumed by the InputManager,
 *           which feeds the SAME facing integrator the keyboard uses, so the
 *           feel and the wire input are identical.
 *   right — ENERGY (hold → primary) and KINETIC (hold → rockets, walker only)
 *           side by side, with a transform button (tap → walker ⇄ hover) above.
 *
 * Built with Pointer Events, so it also responds to a mouse/pen — handy for
 * desktop users who pick touch mode and for the e2e suite. Multiple pointers
 * are tracked independently, so driving and firing at once works.
 */
import type { MechMode } from '@mech-arena-fight/shared';

export interface TouchCallbacks {
  /** transform button tapped (walker ⇄ hover) */
  onTransform: () => void;
}

/** finger travel (px) from the joystick centre that maps to full deflection */
const STICK_RADIUS = 52;

export class TouchControls {
  /** drive/steer vector in the unit disc: x right+, y down+ */
  readonly vector = { x: 0, y: 0 };
  firePressed = false;
  altPressed = false;

  private readonly root: HTMLElement;
  private readonly zone: HTMLElement;
  private readonly base: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly fireBtn: HTMLButtonElement;
  private readonly altBtn: HTMLButtonElement;
  private readonly modeBtn: HTMLButtonElement;

  private stickPointer: number | null = null;
  private originX = 0;
  private originY = 0;

  constructor(
    private readonly cb: TouchCallbacks,
    parent: HTMLElement
  ) {
    this.root = div('touch-controls');

    // ---- left: floating joystick ----
    this.zone = div('touch-stick-zone');
    this.base = div('touch-stick-base');
    this.knob = div('touch-stick-knob');
    this.base.appendChild(this.knob);
    this.zone.appendChild(this.base);
    this.root.appendChild(this.zone);

    // ---- right: action buttons ----
    const actions = div('touch-actions');
    this.modeBtn = actionButton('touch-mode', '⇄', 'Transform');
    this.altBtn = actionButton('touch-alt', 'KINETIC', 'Kinetic');
    this.fireBtn = actionButton('touch-fire', 'ENERGY', 'Energy');
    // The two attack buttons sit side by side so both fit on small screens.
    const fireRow = div('touch-fire-row');
    fireRow.append(this.altBtn, this.fireBtn);
    actions.append(this.modeBtn, fireRow);
    this.root.appendChild(actions);

    parent.appendChild(this.root);

    this.zone.addEventListener('pointerdown', this.onStickDown);
    this.zone.addEventListener('pointermove', this.onStickMove);
    this.zone.addEventListener('pointerup', this.onStickUp);
    this.zone.addEventListener('pointercancel', this.onStickUp);

    this.bindHold(this.fireBtn, (down) => (this.firePressed = down));
    this.bindHold(this.altBtn, (down) => (this.altPressed = down));
    this.modeBtn.addEventListener('pointerdown', this.onModeTap);
  }

  /** Reflect locomotion mode: rockets are walker-only, so grey the button in hover. */
  setMode(mode: MechMode): void {
    this.altBtn.classList.toggle('locked', mode === 'hover');
  }

  /** Clear all held state (match ended / not the player's turn). */
  reset(): void {
    this.firePressed = false;
    this.altPressed = false;
    this.vector.x = 0;
    this.vector.y = 0;
    this.stickPointer = null;
    this.base.classList.remove('active');
    this.knob.style.transform = 'translate(-50%, -50%)';
    this.fireBtn.classList.remove('pressed');
    this.altBtn.classList.remove('pressed');
  }

  dispose(): void {
    this.root.remove();
  }

  // ----------------------------------------------------------- joystick

  private readonly onStickDown = (e: PointerEvent): void => {
    if (this.stickPointer !== null) return; // one finger drives the stick
    e.preventDefault();
    this.stickPointer = e.pointerId;
    this.zone.setPointerCapture(e.pointerId);
    this.originX = e.clientX;
    this.originY = e.clientY;
    this.base.style.left = `${e.clientX}px`;
    this.base.style.top = `${e.clientY}px`;
    this.base.classList.add('active');
    this.track(e.clientX, e.clientY);
  };

  private readonly onStickMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickPointer) return;
    e.preventDefault();
    this.track(e.clientX, e.clientY);
  };

  private readonly onStickUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickPointer) return;
    e.preventDefault();
    this.stickPointer = null;
    this.vector.x = 0;
    this.vector.y = 0;
    this.base.classList.remove('active');
    this.knob.style.transform = 'translate(-50%, -50%)';
  };

  private track(px: number, py: number): void {
    let dx = px - this.originX;
    let dy = py - this.originY;
    const dist = Math.hypot(dx, dy);
    if (dist > STICK_RADIUS) {
      dx = (dx / dist) * STICK_RADIUS;
      dy = (dy / dist) * STICK_RADIUS;
    }
    this.vector.x = dx / STICK_RADIUS;
    this.vector.y = dy / STICK_RADIUS;
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  // ----------------------------------------------------------- buttons

  /** Press-and-hold button: `set(true)` while held, `set(false)` on release. */
  private bindHold(btn: HTMLButtonElement, set: (down: boolean) => void): void {
    let pointer: number | null = null;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pointer = e.pointerId;
      btn.setPointerCapture(e.pointerId);
      btn.classList.add('pressed');
      set(true);
    });
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== pointer) return;
      e.preventDefault();
      pointer = null;
      btn.classList.remove('pressed');
      set(false);
    };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
  }

  private readonly onModeTap = (e: PointerEvent): void => {
    e.preventDefault();
    this.cb.onTransform();
  };
}

function div(id: string): HTMLDivElement {
  const node = document.createElement('div');
  node.id = id;
  return node;
}

function actionButton(id: string, label: string, title: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = id;
  btn.type = 'button';
  btn.className = 'touch-btn';
  btn.textContent = label;
  btn.title = title;
  return btn;
}
