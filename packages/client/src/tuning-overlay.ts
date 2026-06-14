/**
 * In-match tuning overlay (toggle with F2) for dialling in movement feel.
 *
 * Two kinds of knobs:
 *  - turn (rate/accel/drag): integrated client-side, so edits to TURN apply
 *    instantly to the LOCAL mech only.
 *  - mech movement (max speed/accel/drag): server-authoritative — each change
 *    is sent as a `tuneMech` message; the server mutates the running sim's
 *    balance and echoes it back so prediction stays in sync. Affects the whole
 *    room (fine for solo feel-testing).
 *
 * The panel is non-modal: sliders are mouse-driven, so WASD keeps driving while
 * you tune.
 */
import type { MechTuneKey } from '@mech-arena-fight/shared';
import { TURN } from './game/tuning';

export interface TuningOverlayDeps {
  /** Send a server-authoritative mech movement change. */
  onMechChange: (key: MechTuneKey, value: number) => void;
  /** Current value of a mech movement field (running sim, or default). */
  getMechValue: (key: MechTuneKey) => number;
}

type TurnField = 'max' | 'accel' | 'friction' | 'brakeFactor';
type Spec =
  | { group: 'WALKER' | 'HOVER'; label: string; kind: 'turn'; mode: 'walker' | 'hover'; field: TurnField; min: number; max: number; step: number }
  | { group: 'WALKER' | 'HOVER'; label: string; kind: 'mech'; key: MechTuneKey; min: number; max: number; step: number };

const SPECS: Spec[] = [
  { group: 'WALKER', label: 'Turn rate', kind: 'turn', mode: 'walker', field: 'max', min: 0.2, max: 5, step: 0.02 },
  { group: 'WALKER', label: 'Turn accel', kind: 'turn', mode: 'walker', field: 'accel', min: 4, max: 80, step: 1 },
  { group: 'WALKER', label: 'Turn drag', kind: 'turn', mode: 'walker', field: 'friction', min: 1, max: 30, step: 0.5 },
  { group: 'WALKER', label: 'Turn brake×', kind: 'turn', mode: 'walker', field: 'brakeFactor', min: 1, max: 3, step: 0.1 },
  { group: 'WALKER', label: 'Max speed', kind: 'mech', key: 'maxSpeed', min: 1, max: 40, step: 0.5 },
  { group: 'WALKER', label: 'Accel', kind: 'mech', key: 'accel', min: 5, max: 200, step: 1 },
  { group: 'WALKER', label: 'Drag', kind: 'mech', key: 'friction', min: 0.5, max: 20, step: 0.5 },
  { group: 'HOVER', label: 'Turn rate', kind: 'turn', mode: 'hover', field: 'max', min: 0.2, max: 5, step: 0.02 },
  { group: 'HOVER', label: 'Turn accel', kind: 'turn', mode: 'hover', field: 'accel', min: 4, max: 80, step: 1 },
  { group: 'HOVER', label: 'Turn drag', kind: 'turn', mode: 'hover', field: 'friction', min: 0.5, max: 20, step: 0.25 },
  { group: 'HOVER', label: 'Turn brake×', kind: 'turn', mode: 'hover', field: 'brakeFactor', min: 1, max: 3, step: 0.1 },
  { group: 'HOVER', label: 'Max speed', kind: 'mech', key: 'hoverMaxSpeed', min: 1, max: 40, step: 0.5 },
  { group: 'HOVER', label: 'Accel', kind: 'mech', key: 'hoverAccel', min: 5, max: 200, step: 1 },
  { group: 'HOVER', label: 'Drag', kind: 'mech', key: 'hoverFriction', min: 0.5, max: 20, step: 0.2 },
];

const read = (s: Spec, deps: TuningOverlayDeps): number =>
  s.kind === 'turn' ? TURN[s.mode][s.field] : deps.getMechValue(s.key);

export class TuningOverlay {
  private readonly root: HTMLDivElement;
  private readonly rows: { spec: Spec; range: HTMLInputElement; value: HTMLSpanElement }[] = [];
  private readonly readout: HTMLPreElement;
  private isOpen = false;

  constructor(private readonly deps: TuningOverlayDeps) {
    this.root = document.createElement('div');
    this.root.id = 'tune-overlay';
    this.root.setAttribute('data-testid', 'tune-overlay');

    const title = document.createElement('div');
    title.className = 'tune-title';
    title.textContent = 'TUNE  ·  F2';
    this.root.appendChild(title);

    const hint = document.createElement('div');
    hint.className = 'tune-hint';
    hint.textContent = 'turn = local · speed = whole room';
    this.root.appendChild(hint);

    let currentGroup = '';
    for (const spec of SPECS) {
      if (spec.group !== currentGroup) {
        currentGroup = spec.group;
        const h = document.createElement('div');
        h.className = 'tune-group';
        h.textContent = spec.group;
        this.root.appendChild(h);
      }
      this.root.appendChild(this.buildRow(spec));
    }

    this.readout = document.createElement('pre');
    this.readout.className = 'tune-readout';
    this.root.appendChild(this.readout);

    const copy = document.createElement('button');
    copy.className = 'tune-copy';
    copy.textContent = 'Copy values';
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(this.readout.textContent ?? '');
      copy.textContent = 'Copied!';
      window.setTimeout(() => (copy.textContent = 'Copy values'), 1200);
    });
    this.root.appendChild(copy);

    document.body.appendChild(this.root);
    this.refresh();
  }

  private buildRow(spec: Spec): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'tune-row';

    const label = document.createElement('span');
    label.className = 'tune-label';
    label.textContent = spec.label;

    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(spec.min);
    range.max = String(spec.max);
    range.step = String(spec.step);

    const value = document.createElement('span');
    value.className = 'tune-value';

    range.addEventListener('input', () => {
      const v = Number(range.value);
      if (spec.kind === 'turn') TURN[spec.mode][spec.field] = v;
      else this.deps.onMechChange(spec.key, v);
      value.textContent = this.fmt(v);
      this.updateReadout();
    });

    row.append(label, range, value);
    this.rows.push({ spec, range, value });
    return row;
  }

  private fmt(v: number): string {
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }

  /** Pull every slider's position/value from the live sources. */
  private refresh(): void {
    for (const { spec, range, value } of this.rows) {
      const v = read(spec, this.deps);
      range.value = String(v);
      value.textContent = this.fmt(v);
    }
    this.updateReadout();
  }

  /** Re-read just the mech sliders (after a server echo confirms new values). */
  syncMech(): void {
    if (!this.isOpen) return;
    for (const { spec, range, value } of this.rows) {
      if (spec.kind !== 'mech') continue;
      const v = this.deps.getMechValue(spec.key);
      range.value = String(v);
      value.textContent = this.fmt(v);
    }
    this.updateReadout();
  }

  private updateReadout(): void {
    const m = (k: MechTuneKey): string => this.fmt(this.deps.getMechValue(k));
    this.readout.textContent =
      `TURN.walker { accel: ${TURN.walker.accel}, friction: ${TURN.walker.friction}, max: ${TURN.walker.max}, brakeFactor: ${TURN.walker.brakeFactor} }\n` +
      `TURN.hover  { accel: ${TURN.hover.accel}, friction: ${TURN.hover.friction}, max: ${TURN.hover.max}, brakeFactor: ${TURN.hover.brakeFactor} }\n` +
      `walker: maxSpeed ${m('maxSpeed')}, accel ${m('accel')}, friction ${m('friction')}\n` +
      `hover:  maxSpeed ${m('hoverMaxSpeed')}, accel ${m('hoverAccel')}, friction ${m('hoverFriction')}`;
  }

  toggle(): void {
    this.setOpen(!this.isOpen);
  }

  setOpen(open: boolean): void {
    this.isOpen = open;
    this.root.classList.toggle('open', open);
    if (open) this.refresh();
  }
}
