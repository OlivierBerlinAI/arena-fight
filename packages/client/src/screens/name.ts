import { byId } from '../dom';
import { ControlSchemeToggle } from '../controls';

const NAME_KEY = 'mech-arena-fight-name';

export class NameScreen {
  private readonly input = byId<HTMLInputElement>('name-input');
  private readonly submit = byId<HTMLButtonElement>('name-submit');
  private readonly status = byId('name-status');
  // Choose keyboard vs. touch up front; persisted and shared with the in-game toggle.
  private readonly controls = new ControlSchemeToggle(byId('name-control-toggle'));

  constructor(onSubmit: (name: string) => void) {
    // sessionStorage is per-tab, so two tabs can use different names.
    const saved = sessionStorage.getItem(NAME_KEY);
    if (saved) this.input.value = saved;

    const trySubmit = (): void => {
      const name = this.input.value.trim().slice(0, 24);
      if (!name) {
        this.setStatus('Enter a callsign first.');
        return;
      }
      try {
        sessionStorage.setItem(NAME_KEY, name);
      } catch {
        /* private mode etc. — fine */
      }
      this.setStatus('Connecting…');
      onSubmit(name);
    };

    this.submit.addEventListener('click', trySubmit);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') trySubmit();
    });
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  focus(): void {
    this.input.focus();
  }
}
