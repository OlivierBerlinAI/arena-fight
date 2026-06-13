/**
 * Control-scheme selection shared across the whole client.
 *
 *  - 'keyboard' — the classic desktop controls (W/S/A/D, M/N, F, 1/2). Unchanged.
 *  - 'touch'    — on-screen joystick + buttons so the game is fully playable on
 *                 a phone or tablet with no keyboard or mouse.
 *
 * The choice is persisted (localStorage) and auto-detected on first run from the
 * primary pointer type, so a touch device defaults to touch and a desktop to
 * keyboard. The active match and the HUD react through `onControlSchemeChange`.
 */

export type ControlScheme = 'keyboard' | 'touch';

const STORAGE_KEY = 'precinct-duel-controls';

/** First-run default: touch when the primary pointer is coarse (phone/tablet). */
function detectDefault(): ControlScheme {
  try {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) {
      return 'touch';
    }
  } catch {
    /* matchMedia unavailable — fall through to keyboard */
  }
  return 'keyboard';
}

function load(): ControlScheme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'keyboard' || saved === 'touch') return saved;
  } catch {
    /* private mode etc. — fine */
  }
  return detectDefault();
}

let current: ControlScheme = load();
const listeners = new Set<(scheme: ControlScheme) => void>();

export function getControlScheme(): ControlScheme {
  return current;
}

export function setControlScheme(scheme: ControlScheme): void {
  if (scheme === current) return;
  current = scheme;
  try {
    localStorage.setItem(STORAGE_KEY, scheme);
  } catch {
    /* ignore persistence failures */
  }
  for (const cb of listeners) cb(scheme);
}

/** Subscribe to scheme changes; returns an unsubscribe function. */
export function onControlSchemeChange(cb: (scheme: ControlScheme) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Wires a segmented [KEYBOARD | TOUCH] toggle: any element inside `root` that
 * carries `data-scheme="keyboard|touch"` becomes a button. Selection stays in
 * sync with the shared state, so several toggles (start screen + controls
 * overlay) reflect one another.
 */
export class ControlSchemeToggle {
  private readonly buttons: HTMLButtonElement[];
  private readonly unsubscribe: () => void;
  private readonly onClicks = new Map<HTMLButtonElement, () => void>();

  constructor(root: HTMLElement) {
    this.buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-scheme]'));
    for (const btn of this.buttons) {
      const scheme = btn.dataset.scheme as ControlScheme;
      const handler = (): void => setControlScheme(scheme);
      btn.addEventListener('click', handler);
      this.onClicks.set(btn, handler);
    }
    this.sync(getControlScheme());
    this.unsubscribe = onControlSchemeChange((scheme) => this.sync(scheme));
  }

  private sync(scheme: ControlScheme): void {
    for (const btn of this.buttons) {
      btn.classList.toggle('active', btn.dataset.scheme === scheme);
    }
  }

  dispose(): void {
    this.unsubscribe();
    for (const [btn, handler] of this.onClicks) btn.removeEventListener('click', handler);
    this.onClicks.clear();
  }
}
