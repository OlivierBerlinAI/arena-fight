/**
 * Procedural 8-bit / chiptune sound engine — no external assets, every sound
 * is synthesised at runtime with the Web Audio API (NES-style band-limited
 * pulse waves for tones, a filtered white-noise channel for explosions).
 *
 * Fully defensive: if Web Audio is unavailable or a call throws, it silently
 * no-ops. The context starts suspended (autoplay policy) and resumes on the
 * first user gesture. Mute state persists in localStorage.
 */
import type { PlayerIndex, ProjectileSnap, SimEvent } from '@mech-arena-fight/shared';

const MUSIC_MUTE_KEY = 'mech-arena-fight.muted.music';
const SFX_MUTE_KEY = 'mech-arena-fight.muted.sfx';

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

// --------------------------------------------------------------- soundtracks
// Two looping, fully-synthesised retro-futuristic tracks (a calm synthwave
// lobby theme and a driving battle theme) scheduled with a lookahead clock.

/** Output level of the dedicated music bus, sitting under the SFX. */
const MUSIC_VOL = 0.55;
/** How far ahead the sequencer schedules notes (seconds). */
const MUSIC_LOOKAHEAD = 0.12;
/** How often the sequencer wakes to schedule the next slice (ms). */
const MUSIC_TICK_MS = 25;

type MusicTrackName = 'lobby' | 'game';

interface TrackDef {
  bpm: number;
  /** total 16th-note steps in one loop (4 bars × 16) */
  steps: number;
  play: (step: number, at: number) => void;
}

/** Equal-tempered frequency of a note name like `A4`, `C#3`, `G#5`. */
const SEMITONE: Record<string, number> = {
  C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4, 'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2,
};
function hz(note: string): number {
  const m = /^([A-G]#?)(\d)$/.exec(note);
  if (!m) return 440;
  const semis = SEMITONE[m[1]] + (Number(m[2]) - 4) * 12;
  return 440 * 2 ** (semis / 12);
}

interface Chord {
  bass: number;
  triad: [number, number, number];
}
function chord(bassNote: string, a: string, b: string, c: string): Chord {
  return { bass: hz(bassNote), triad: [hz(a), hz(b), hz(c)] };
}

/** Eight-step (eighth-note) up-and-down arpeggio over a triad. */
function arp8([r, th, f]: [number, number, number]): number[] {
  return [r, th, f, r * 2, f, th, r, th];
}
/** Sixteen-step (sixteenth-note) bubbling arpeggio over a triad. */
function arp16([r, th, f]: [number, number, number]): number[] {
  const cell = [r, th, f, r * 2];
  return [...cell, ...cell, ...cell, ...cell];
}

// Lobby — Am · F · C · G, the wistful "standby" synthwave loop.
const LOBBY_CHORDS: Chord[] = [
  chord('A2', 'A3', 'C4', 'E4'),
  chord('F2', 'F3', 'A3', 'C4'),
  chord('C3', 'C4', 'E4', 'G4'),
  chord('G2', 'G3', 'B3', 'D4'),
];
const LOBBY_ARP = LOBBY_CHORDS.map((c) => arp8(c.triad));
/** Sparse high bell motif, one hit just after a few downbeats. */
const LOBBY_BELL = ((): number[] => {
  const a = new Array<number>(64).fill(0);
  a[2] = hz('E5');
  a[20] = hz('C5');
  a[34] = hz('G5');
  a[52] = hz('B4');
  return a;
})();

// Game — Am · F · G · E (harmonic-minor V), tense and driving.
const GAME_CHORDS: Chord[] = [
  chord('A2', 'A3', 'C4', 'E4'),
  chord('F2', 'F3', 'A3', 'C4'),
  chord('G2', 'G3', 'B3', 'D4'),
  chord('E2', 'E3', 'G#3', 'B3'),
];
const GAME_ARP = GAME_CHORDS.map((c) => arp16(c.triad));
/** Heroic lead, one note per beat (16 across the loop), all chord tones. */
const GAME_LEAD = [
  'A3', 'E4', 'C4', 'E4',
  'F4', 'C4', 'A3', 'C4',
  'G4', 'D4', 'B3', 'D4',
  'E4', 'B3', 'G#3', 'B3',
].map(hz);
/** Second lead — an answering, rising counter-melody that arrives on the 3rd pass. */
const GAME_LEAD2 = [
  'C4', 'E4', 'A4', 'E4',
  'A3', 'C4', 'F4', 'C4',
  'B3', 'D4', 'G4', 'D4',
  'G#3', 'B3', 'E4', 'B3',
].map(hz);
/** Slow half-note sub-bass line (root↔fifth) that walks under the driving pulse. */
const GAME_BASS_MEL = ['A2', 'E3', 'F2', 'C3', 'G2', 'D3', 'E2', 'B2'].map(hz);

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** dedicated bus for the soundtracks so they can be levelled/faded apart from SFX */
  private musicGain: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private pulse25: PeriodicWave | null = null;
  private pulse12: PeriodicWave | null = null;
  private musicMuted = false;
  private sfxMuted = false;
  private readonly lastAt = new Map<string, number>();
  /** projectile ids seen in the previous snapshot, for fire/detonation diffing */
  private prevProj = new Map<number, ProjectileSnap['kind']>();

  // music sequencer state
  private musicTrack: MusicTrackName | null = null;
  private musicTimer: number | null = null;
  private nextStepTime = 0;
  private musicStep = 0;
  /** how many full loops the current track has played (drives the lead's octave flip) */
  private musicLoop = 0;
  private readonly tracks: Record<MusicTrackName, TrackDef> = {
    lobby: { bpm: 90, steps: 64, play: (s, t): void => this.lobbyStep(s, t) },
    game: { bpm: 140, steps: 64, play: (s, t): void => this.gameStep(s, t) },
  };

  constructor() {
    try {
      this.musicMuted = localStorage.getItem(MUSIC_MUTE_KEY) === '1';
      this.sfxMuted = localStorage.getItem(SFX_MUTE_KEY) === '1';
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

      // Music rides its own sub-bus; it starts silent and is faded in by
      // playMusic() so the soundtrack never bursts in before the first gesture.
      const musicGain = this.ctx.createGain();
      musicGain.gain.value = 0;
      musicGain.connect(master);
      this.musicGain = musicGain;

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

  get isMusicMuted(): boolean {
    return this.musicMuted;
  }

  get isSfxMuted(): boolean {
    return this.sfxMuted;
  }

  /** Toggle the soundtrack on/off (persisted); fades the music bus. */
  toggleMusicMuted(): boolean {
    this.musicMuted = !this.musicMuted;
    this.persistMute(MUSIC_MUTE_KEY, this.musicMuted);
    this.applyMusicGain();
    return this.musicMuted;
  }

  /** Toggle the sound effects on/off (persisted). */
  toggleSfxMuted(): boolean {
    this.sfxMuted = !this.sfxMuted;
    this.persistMute(SFX_MUTE_KEY, this.sfxMuted);
    return this.sfxMuted;
  }

  private persistMute(key: string, on: boolean): void {
    try {
      localStorage.setItem(key, on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  /** SFX are live unless the effects channel is muted. */
  private get live(): boolean {
    return this.ctx !== null && this.master !== null && !this.sfxMuted;
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

  /** Apply a built-in oscillator type or a custom periodic wave. */
  private applyWave(osc: OscillatorNode, wave: Wave): void {
    if (wave instanceof PeriodicWave) osc.setPeriodicWave(wave);
    else osc.type = wave;
  }

  private voice(freq: number, opts: VoiceOpts = {}): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const { dur = 0.1, vol = 0.2, wave = 'square', sweepTo, when = 0, attack = 0.006 } = opts;
    const t = ctx.currentTime + 0.001 + when;
    const osc = ctx.createOscillator();
    this.applyWave(osc, wave);
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
      case 'unitDeployed': {
        const dread = ev.unit === 'dreadnought';
        if (ev.player !== me) {
          // Enemy fielded a unit — a dreadnought rolling out earns a klaxon.
          if (dread) this.dreadnoughtWarning();
          else this.voice(300, { wave: 'square', dur: 0.07, vol: 0.07 });
        } else if (dread) {
          // Your own heavy walker deploys with a weightier confirmation.
          this.arp([392, 523, 784], 0.07, { wave: this.pulse25 ?? 'square', dur: 0.12, vol: 0.16 });
          this.voice(98, { wave: 'triangle', dur: 0.35, vol: 0.18, sweepTo: 70 });
        } else {
          this.arp([523, 784], 0.06, { wave: this.pulse25 ?? 'square', dur: 0.08, vol: 0.14 });
        }
        break;
      }
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

  /**
   * Enemy dreadnought alert: an ominous low swell, a descending alarm sweep and
   * an urgent low two-tone klaxon. Distinct (lower, heavier) from the base-attack
   * warning so it reads instantly as "a heavy unit is incoming".
   */
  private dreadnoughtWarning(): void {
    if (!this.throttle('dread', 0.4)) return; // collapse simultaneous deploys
    // rising sub rumble + descending klaxon sweep
    this.voice(70, { wave: 'triangle', dur: 0.8, vol: 0.22, sweepTo: 130 });
    this.voice(880, { wave: this.pulse12 ?? 'square', dur: 0.5, vol: 0.16, sweepTo: 220 });
    // three urgent low two-tone blips (Bb4 / Eb4)
    for (let i = 0; i < 3; i++) {
      const when = i * 0.26;
      this.voice(466, { wave: 'square', dur: 0.12, vol: 0.2, when });
      this.voice(311, { wave: 'square', dur: 0.12, vol: 0.2, when: when + 0.13 });
    }
    // metallic noise stab to punctuate the alarm
    this.noise({ dur: 0.4, vol: 0.18, from: 2000, to: 160 });
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

  // ----------------------------------------------------------- soundtrack

  /**
   * Start (or switch to) a looping soundtrack. Idempotent for the current track.
   * Safe to call before the first gesture — nothing is heard until the context
   * resumes, and the sequencer only advances while the context is running.
   */
  playMusic(track: MusicTrackName): void {
    if (this.musicTrack === track) return;
    this.musicTrack = track;
    this.musicStep = 0;
    this.musicLoop = 0;
    if (this.ctx) this.nextStepTime = this.ctx.currentTime + 0.06;
    this.resume();
    this.applyMusicGain();
    if (this.musicTimer === null) {
      this.musicTimer = window.setInterval(() => this.pump(), MUSIC_TICK_MS);
    }
  }

  /** Stop the soundtrack and fade the music bus out (SFX keep playing). */
  stopMusic(): void {
    if (this.musicTrack === null) return;
    this.musicTrack = null;
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
    this.applyMusicGain();
  }

  /** Fade the music bus toward its target level (0 when muted or stopped). */
  private applyMusicGain(): void {
    const ctx = this.ctx;
    const g = this.musicGain;
    if (!ctx || !g) return;
    const target = this.musicMuted || this.musicTrack === null ? 0 : MUSIC_VOL;
    const now = ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(target, now + 0.12);
  }

  /** Lookahead scheduler: emit every step whose time falls inside the window. */
  private pump(): void {
    try {
      const ctx = this.ctx;
      const name = this.musicTrack;
      if (!ctx || name === null) return;
      const track = this.tracks[name];
      // Hold the clock steady while suspended or muted so we resume without a burst.
      if (this.musicMuted || ctx.state !== 'running') {
        this.nextStepTime = ctx.currentTime;
        return;
      }
      if (this.nextStepTime < ctx.currentTime) this.nextStepTime = ctx.currentTime + 0.02;
      const stepDur = 15 / track.bpm; // 60 / bpm / 4 → one sixteenth note
      while (this.nextStepTime < ctx.currentTime + MUSIC_LOOKAHEAD) {
        track.play(this.musicStep, this.nextStepTime);
        this.musicStep += 1;
        if (this.musicStep >= track.steps) {
          this.musicStep = 0;
          this.musicLoop += 1;
        }
        this.nextStepTime += stepDur;
      }
    } catch {
      /* never let the soundtrack throw out of a timer */
    }
  }

  // --------------------------------------------------- music synth voices

  /** A music note routed through the music bus, with a pluck or sustain shape. */
  private mvoice(
    freq: number,
    at: number,
    dur: number,
    vol: number,
    wave: Wave,
    opts: { sweepTo?: number; attack?: number; release?: number; sustain?: boolean } = {}
  ): void {
    const ctx = this.ctx;
    const dest = this.musicGain;
    if (!ctx || !dest) return;
    const { sweepTo, attack = 0.006, release = 0.05, sustain = false } = opts;
    const v = Math.max(0.0002, vol);
    const osc = ctx.createOscillator();
    this.applyWave(osc, wave);
    osc.frequency.setValueAtTime(Math.max(1, freq), at);
    if (sweepTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(v, at + attack);
    if (sustain) g.gain.setValueAtTime(v, Math.max(at + attack + 0.005, at + dur - release));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(dest);
    osc.start(at);
    osc.stop(at + dur + 0.03);
  }

  /** A filtered noise burst on the music bus (drum bodies / cymbals). */
  private mnoise(
    at: number,
    dur: number,
    vol: number,
    opts: { from: number; to: number; type?: BiquadFilterType; q?: number }
  ): void {
    const ctx = this.ctx;
    const dest = this.musicGain;
    if (!ctx || !dest || !this.noiseBuf) return;
    const { from, to, type = 'lowpass', q } = opts;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(from, at);
    filt.frequency.exponentialRampToValueAtTime(Math.max(40, to), at + dur);
    if (q !== undefined) filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(filt).connect(g).connect(dest);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  private mkick(at: number, vol = 0.3): void {
    this.mvoice(140, at, 0.13, vol, 'triangle', { sweepTo: 46, attack: 0.002 });
    this.mnoise(at, 0.02, vol * 0.4, { from: 5000, to: 1000 }); // beater click
  }

  private msnare(at: number, vol = 0.22): void {
    this.mnoise(at, 0.16, vol, { from: 3200, to: 800, type: 'bandpass', q: 0.8 });
    this.mvoice(190, at, 0.12, vol * 0.45, 'square', { sweepTo: 120, attack: 0.002 });
  }

  private mhat(at: number, vol = 0.05, open = false): void {
    this.mnoise(at, open ? 0.1 : 0.035, vol, { from: 9000, to: 6000, type: 'highpass' });
  }

  // ----------------------------------------------------- per-step sequencing

  /** Lobby theme: gentle pad, eighth-note arpeggio, soft bass and sparse bells. */
  private lobbyStep(step: number, t: number): void {
    const bar = (step >> 4) & 3;
    const s = step & 15;
    const ch = LOBBY_CHORDS[bar];
    const sd = 15 / 90; // sixteenth-note duration

    if (s === 0) {
      this.mvoice(ch.bass, t, sd * 7.5, 0.17, 'triangle', { sustain: true, attack: 0.012 });
      for (const f of ch.triad) {
        this.mvoice(f, t, sd * 15.5, 0.03, this.pulse12 ?? 'square', { sustain: true, attack: 0.12, release: 0.5 });
      }
    }
    if (s === 8) this.mvoice(ch.bass * 2, t, sd * 3.5, 0.06, 'triangle', { sustain: true });
    if ((s & 1) === 0) {
      this.mvoice(LOBBY_ARP[bar][s >> 1], t, sd * 1.5, 0.07, this.pulse25 ?? 'square', { attack: 0.004 });
    }
    const bell = LOBBY_BELL[step];
    if (bell) this.mvoice(bell, t, sd * 3, 0.05, this.pulse12 ?? 'square', { attack: 0.005 });
  }

  /** Battle theme: driving bass, fast arp, stabs, a heroic lead and chip drums. */
  private gameStep(step: number, t: number): void {
    const bar = (step >> 4) & 3;
    const s = step & 15;
    const ch = GAME_CHORDS[bar];
    const sd = 15 / 140;

    // slow, melodic sub-bass: a sustained half-note bass line walking root↔fifth
    if ((s & 7) === 0) {
      this.mvoice(GAME_BASS_MEL[(step >> 3) & 7], t, sd * 8, 0.18, 'triangle', { attack: 0.01, release: 0.08, sustain: true });
    }
    // driving sixteenth-note root pulse — tighter/quieter now the bass line carries the low end
    const accent = (s & 3) === 0;
    this.mvoice(ch.bass, t, sd * 0.7, accent ? 0.13 : 0.08, 'triangle', { attack: 0.003 });
    // fast arpeggio bed
    this.mvoice(GAME_ARP[bar][s], t, sd * 0.9, 0.055, this.pulse25 ?? 'square', { attack: 0.003 });
    // syncopated chord stabs on the offbeats of beats 2 and 4
    if (s === 6 || s === 14) {
      for (const f of ch.triad) this.mvoice(f, t, sd * 1.4, 0.06, this.pulse12 ?? 'square', { attack: 0.004 });
    }
    // heroic lead, one sustained note per beat. A three-loop rotation: an octave
    // down, then the current octave, then a second answering melody — repeating.
    if (accent) {
      const beat = (step >> 2) & 15;
      const phase = this.musicLoop % 3;
      const lead = phase === 0 ? GAME_LEAD[beat] * 0.5 : phase === 1 ? GAME_LEAD[beat] : GAME_LEAD2[beat];
      this.mvoice(lead, t, sd * 3.2, 0.06, this.pulse25 ?? 'square', { attack: 0.005, sustain: true });
    }
    // chip drum kit
    if (s === 0 || s === 4 || s === 8 || s === 12) this.mkick(t);
    if (s === 4 || s === 12) this.msnare(t);
    if ((s & 1) === 0) this.mhat(t, 0.05);
    if (s === 14) this.mhat(t, 0.06, true); // open-hat pickup into the next bar
  }
}
