import { describe, expect, it } from 'vitest';
import { GameSimulation } from '@precinct/shared';
import type { PlayerInput, SimCommand } from '@precinct/shared';
import { buildCmd, makeInput } from './helpers';

/**
 * Scripted match: both mechs roam and fire (exercising the PRNG via gatling
 * spread), rockets launch periodically, and both players build units. Purely
 * a function of the tick number, so two sims fed this script stay in lockstep.
 */
function scriptedInputs(t: number): [PlayerInput, PlayerInput] {
  return [
    makeInput({
      mx: Math.sin(t / 13),
      mz: Math.cos(t / 31),
      aimX: 40 * Math.sin(t / 47),
      aimZ: 40 * Math.cos(t / 53),
      fire: t % 50 < 30,
      alt: t % 120 < 10,
    }),
    makeInput({
      mx: -Math.cos(t / 17),
      mz: Math.sin(t / 37),
      aimX: -30 * Math.cos(t / 43),
      aimZ: 30 * Math.sin(t / 59),
      fire: t % 70 < 40,
      alt: t % 150 < 10,
    }),
  ];
}

function scriptedCommands(t: number): SimCommand[] {
  const cmds: SimCommand[] = [];
  if (t > 0 && t % 150 === 0) cmds.push(buildCmd(0, 'hovertank'));
  if (t > 0 && t % 220 === 0) cmds.push(buildCmd(1, t % 440 === 0 ? 'dreadnought' : 'hovertank'));
  return cmds;
}

function runScripted(seed: number, ticks: number): GameSimulation {
  const sim = new GameSimulation({ seed });
  for (let i = 0; i < ticks; i++) {
    const t = sim.state.tick;
    sim.tick(scriptedInputs(t), scriptedCommands(t));
  }
  return sim;
}

describe('determinism', () => {
  it('same seed + same input sequence over 1500 ticks ⇒ identical state hash', () => {
    const a = runScripted(123456, 1500);
    const b = runScripted(123456, 1500);
    expect(a.hash()).toBe(b.hash());
    expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()));
    // Sanity: the script actually exercised the PRNG (gatling spread draws).
    expect(a.state.rngState).not.toBe(123456 >>> 0);
    // Sanity: combat and economy actually happened.
    expect(a.state.tick).toBe(1500);
    expect(a.state.players[0].stats.robotsBuilt).toBeGreaterThan(0);
  });

  it('stays in lockstep at every checkpoint along the way', () => {
    const a = new GameSimulation({ seed: 777 });
    const b = new GameSimulation({ seed: 777 });
    for (let i = 0; i < 1200; i++) {
      const t = a.state.tick;
      a.tick(scriptedInputs(t), scriptedCommands(t));
      b.tick(scriptedInputs(t), scriptedCommands(t));
      if (i % 100 === 99) expect(a.hash()).toBe(b.hash());
    }
    expect(a.hash()).toBe(b.hash());
  });

  it('a different seed produces a different final hash', () => {
    const a = runScripted(123456, 1500);
    const c = runScripted(654321, 1500);
    expect(a.hash()).not.toBe(c.hash());
  });
});
