/**
 * Procedural 8-bit / chiptune sound engine — no external assets, every sound
 * is synthesised at runtime with the Web Audio API (NES-style band-limited
 * pulse waves for tones, a filtered white-noise channel for explosions).
 *
 * Fully defensive: if Web Audio is unavailable or a call throws, it silently
 * no-ops. The context starts suspended (autoplay policy) and resumes on the
 * first user gesture. Mute state persists in localStorage.
 */
import type { PlayerIndex, ProjectileSnap, SimEvent } from '@precinct/shared';

const MUTE_KEY = 'precinct.muted';

type Wave = OscillatorType | PeriodicWave;

interface VoiceOpts {
  dur?: number;
  vol?: number;
  wave?: Wave;
  /** end frequency for an exponential pitch sweep */
  sweepTo?: number;
  /** delay before the note starts, seconds */
  when?: number;
  attack?: number;
}

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private pulse25: PeriodicWave | null = null;
  private pulse12: PeriodicWave | null = null;
  private muted = false;
  private readonly lastAt = new Map<string, number>();
  /** projectile ids seen in the previous snapshot, for fire/detonation diffing */
  private prevProj = new Map<number, ProjectileSnap['kind']>();

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      /* private mode / no storage — default unmuted */
    }
    this.tryInit();
    // Browsers start the context suspended until a user gesture.
    const resume = (): void => {
      this.resume();
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
    };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
  }

  private tryInit(): void {
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      const master = this.ctx.createGain();
      master.gain.value = 0.5;
      const comp = this.ctx.createDynamicsCompressor();
      master.connect(comp).connect(this.ctx.destination);
      this.master = master;

      // one second of white noise, reused by every explosion/hit
      const len = Math.floor(this.ctx.sampleRate);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;

      this.pulse25 = this.makePulse(0.25);
      this.pulse12 = this.makePulse(0.125);
    } catch {
      this.ctx = null;
    }
  }

  /** Band-limited pulse wave of the given duty cycle (authentic NES timbre). */
  private makePulse(duty: number): PeriodicWave {
    const ctx = this.ctx!;
    const n = 24;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let i = 1; i < n; i++) imag[i] = (2 / (i * Math.PI)) * Math.sin(i * Math.PI * duty);
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Toggle mute, persist it, return the new state. */
  toggleMuted(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    return this.muted;
  }

  private get live(): boolean {
    return this.ctx !== null && this.master !== null && !this.muted;
  }

  /** True at most once per `minGap` seconds for the given key (rate limiter). */
  private throttle(key: string, minGap: number): boolean {
    const now = this.ctx!.currentTime;
    const last = this.lastAt.get(key) ?? -Infinity;
    if (now - last < minGap) return false;
    this.lastAt.set(key, now);
    return true;
  }

  // ----------------------------------------------------------- synth voices

  private voice(freq: number, opts: VoiceOpts = {}): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const { dur = 0.1, vol = 0.2, wave = 'square', sweepTo, when = 0, attack = 0.006 } = opts;
    const t = ctx.currentTime + 0.001 + when;
    const osc = ctx.createOscillator();
    if (typeof wave === 'string') osc.type = wave;
    else osc.setPeriodicWave(wave);
    osc.frequency.setValueAtTime(Math.max(1, freq), t);
    if (sweepTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  private noise(opts: { dur?: number; vol?: number; from?: number; to?: number; when?: number } = {}): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noiseBuf) return;
    const { dur = 0.3, vol = 0.35, from = 1400, to = 80, when = 0 } = opts;
    const t = ctx.currentTime + 0.001 + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(from, t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(40, to), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.03);
  }

  /** Play a melodic sequence (chiptune arpeggio / jingle). */
  private arp(freqs: number[], step: number, opts: VoiceOpts = {}): void {
    freqs.forEach((f, i) => this.voice(f, { ...opts, when: (opts.when ?? 0) + i * step }));
  }

  // ----------------------------------------------------------- weapon fire

  /** Route newly-spawned / vanished projectiles to fire & detonation sounds. */
  onProjectiles(projectiles: ProjectileSnap[]): void {
    if (!this.live) {
      // still track ids so we don't burst-play on unmute
      this.prevProj = new Map(projectiles.map((p) => [p.id, p.kind]));
      return;
    }
    const next = new Map<number, ProjectileSnap['kind']>();
    for (const p of projectiles) {
      next.set(p.id, p.kind);
      if (!this.prevProj.has(p.id)) this.fire(p.kind);
    }
    for (const [id, kind] of this.prevProj) {
      if (!next.has(id)) this.detonate(kind);
    }
    this.prevProj = next;
  }

  private fire(kind: ProjectileSnap['kind']): void {
    try {
      switch (kind) {
        case 'gatling':
          if (this.throttle('gat', 0.05)) this.voice(1300, { wave: 'square', dur: 0.04, vol: 0.08, sweepTo: 950 });
          break;
        case 'laser':
          if (this.throttle('las', 0.05))
            this.voice(1900, { wave: this.pulse25 ?? 'square', dur: 0.11, vol: 0.13, sweepTo: 520 });
          break;
        case 'rocket':
          this.noise({ dur: 0.18, vol: 0.18, from: 800, to: 120 });
          this.voice(190, { wave: 'triangle', dur: 0.2, vol: 0.18, sweepTo: 90 });
          break;
        case 'unitLight':
          if (this.throttle('ul', 0.1)) this.voice(720, { wave: this.pulse25 ?? 'square', dur: 0.05, vol: 0.07 });
          break;
        case 'unitHeavy':
          if (this.throttle('uh', 0.1)) {
            this.voice(240, { wave: 'square', dur: 0.1, vol: 0.12, sweepTo: 150 });
            this.noise({ dur: 0.08, vol: 0.08, from: 600, to: 120 });
          }
          break;
        case 'turret':
          if (this.throttle('tur', 0.1)) this.voice(980, { wave: this.pulse12 ?? 'square', dur: 0.04, vol: 0.06 });
          break;
      }
    } catch {
      /* never let audio break the frame */
    }
  }

  private detonate(kind: ProjectileSnap['kind']): void {
    try {
      // Splash kinds always "detonate"; tracer kinds just expire silently.
      if (kind === 'rocket') {
        if (this.throttle('boom', 0.04)) {
          this.noise({ dur: 0.38, vol: 0.34, from: 1300, to: 70 });
          this.voice(130, { wave: 'triangle', dur: 0.32, vol: 0.22, sweepTo: 45 });
        }
      } else if (kind === 'unitHeavy') {
        if (this.throttle('boom', 0.04)) {
          this.noise({ dur: 0.3, vol: 0.28, from: 1000, to: 70 });
          this.voice(150, { wave: 'triangle', dur: 0.26, vol: 0.18, sweepTo: 50 });
        }
      }
    } catch {
      /* ignore */
    }
  }

  // ----------------------------------------------------------- match events

  /** Map a tick's SimEvents to feedback, phrased from the local player's POV. */
  onMatchEvents(events: SimEvent[], me: PlayerIndex): void {
    if (!this.live) return;
    try {
      for (const ev of events) this.event(ev, me);
    } catch {
      /* ignore */
    }
  }

  private event(ev: SimEvent, me: PlayerIndex): void {
    switch (ev.type) {
      case 'unitQueued':
        if (ev.player === me) this.voice(880, { wave: this.pulse25 ?? 'square', dur: 0.05, vol: 0.12 });
        break;
      case 'unitDeployed':
        if (ev.player === me) this.arp([523, 784], 0.06, { wave: this.pulse25 ?? 'square', dur: 0.08, vol: 0.14 });
        else this.voice(300, { wave: 'square', dur: 0.07, vol: 0.07 });
        break;
      case 'unitDestroyed':
        this.noise({ dur: 0.22, vol: ev.owner === me ? 0.24 : 0.18, from: 900, to: 80 });
        this.voice(ev.owner === me ? 200 : 320, { wave: 'square', dur: 0.16, vol: 0.1, sweepTo: ev.owner === me ? 90 : 180 });
        break;
      case 'mechKilled':
        if (ev.victim === me) {
          // your death: descending warble + boom
          this.arp([600, 440, 300, 160], 0.07, { wave: 'square', dur: 0.1, vol: 0.2, sweepTo: undefined });
          this.noise({ dur: 0.5, vol: 0.34, from: 1400, to: 50, when: 0.06 });
        } else {
          this.arp([400, 600, 880], 0.06, { wave: this.pulse25 ?? 'square', dur: 0.09, vol: 0.16 });
          this.noise({ dur: 0.3, vol: 0.2, from: 1100, to: 70 });
        }
        break;
      case 'mechRespawned':
        if (ev.player === me) this.arp([330, 494, 659], 0.05, { wave: this.pulse25 ?? 'square', dur: 0.08, vol: 0.16 });
        break;
      case 'turretCaptured':
        if (ev.player === me) this.arp([523, 659, 784, 1047], 0.06, { wave: this.pulse25 ?? 'square', dur: 0.1, vol: 0.18 });
        else this.arp([392, 311], 0.08, { wave: 'square', dur: 0.12, vol: 0.14 });
        break;
      case 'turretNeutralized':
        if (ev.byPlayer === me) this.arp([659, 784], 0.06, { wave: this.pulse25 ?? 'square', dur: 0.09, vol: 0.14 });
        else this.arp([440, 330], 0.07, { wave: 'square', dur: 0.1, vol: 0.13 });
        break;
      case 'turretDestroyed':
        this.noise({ dur: 0.34, vol: 0.3, from: 1500, to: 60 });
        this.voice(1200, { wave: 'square', dur: 0.05, vol: 0.12, when: 0.02 }); // metallic clang
        this.voice(140, { wave: 'triangle', dur: 0.3, vol: 0.2, sweepTo: 50 });
        break;
      case 'turretRespawned':
        this.arp([392, 523], 0.07, { wave: this.pulse12 ?? 'square', dur: 0.09, vol: 0.1 });
        break;
      case 'baseUnderAttack':
        if (ev.player === me) {
          // urgent two-tone klaxon
          for (let i = 0; i < 3; i++) {
            this.voice(740, { wave: 'square', dur: 0.12, vol: 0.18, when: i * 0.26 });
            this.voice(560, { wave: 'square', dur: 0.12, vol: 0.18, when: i * 0.26 + 0.13 });
          }
        } else {
          this.voice(880, { wave: this.pulse25 ?? 'square', dur: 0.1, vol: 0.1 });
        }
        break;
      case 'buildRejected':
        if (ev.player === me) {
          this.voice(220, { wave: 'square', dur: 0.09, vol: 0.16 });
          this.voice(180, { wave: 'square', dur: 0.12, vol: 0.16, when: 0.1 });
        }
        break;
      default:
        break;
    }
  }

  // ----------------------------------------------------------- transform + UI

  /** Walker ⇄ hover transform: rising power-up / falling power-down sweep. */
  transform(toHover: boolean): void {
    if (!this.live) return;
    try {
      const notes = toHover ? [330, 440, 587, 880] : [880, 587, 440, 330];
      this.arp(notes, 0.05, { wave: this.pulse25 ?? 'square', dur: 0.09, vol: 0.16 });
      this.noise({ dur: 0.2, vol: 0.08, from: toHover ? 400 : 1600, to: toHover ? 1800 : 200 });
    } catch {
      /* ignore */
    }
  }

  uiClick(): void {
    if (!this.live) return;
    try {
      this.voice(660, { wave: this.pulse25 ?? 'square', dur: 0.045, vol: 0.12, sweepTo: 880 });
    } catch {
      /* ignore */
    }
  }

  // ----------------------------------------------------------- match lifecycle

  /** A countdown number (3,2,1); the final tick is brighter. */
  countdownTick(secondsRemaining: number): void {
    if (!this.live) return;
    try {
      const last = secondsRemaining <= 1;
      this.voice(last ? 880 : 520, { wave: 'square', dur: last ? 0.18 : 0.1, vol: 0.2 });
    } catch {
      /* ignore */
    }
  }

  matchStart(): void {
    if (!this.live) return;
    try {
      this.arp([523, 659, 784, 1047], 0.08, { wave: this.pulse25 ?? 'square', dur: 0.14, vol: 0.2 });
    } catch {
      /* ignore */
    }
  }

  victory(): void {
    if (!this.live) return;
    try {
      this.arp([523, 659, 784, 1047, 1319], 0.11, { wave: this.pulse25 ?? 'square', dur: 0.2, vol: 0.22 });
      this.voice(1047, { wave: this.pulse25 ?? 'square', dur: 0.5, vol: 0.2, when: 0.55 });
      this.voice(1568, { wave: this.pulse12 ?? 'square', dur: 0.5, vol: 0.16, when: 0.55 });
    } catch {
      /* ignore */
    }
  }

  defeat(): void {
    if (!this.live) return;
    try {
      this.arp([523, 440, 349, 262], 0.16, { wave: 'square', dur: 0.24, vol: 0.2 });
      this.voice(196, { wave: 'triangle', dur: 0.7, vol: 0.2, when: 0.66, sweepTo: 130 });
    } catch {
      /* ignore */
    }
  }
}
