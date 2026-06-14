import { describe, expect, it } from 'vitest';
import { validateClientMessage } from '@precinct/shared';

const baseInput = { type: 'input', mx: 0, mz: 0, aimX: 0, aimZ: 0, fire: false, alt: false };

describe('validateClientMessage — input.mode', () => {
  it('defaults an absent mode to walker (backward compatible)', () => {
    const res = validateClientMessage({ ...baseInput });
    expect(res.ok).toBe(true);
    if (res.ok && res.msg.type === 'input') {
      expect(res.msg.mode).toBe('walker');
    } else {
      throw new Error('expected a valid input message');
    }
  });

  it('accepts an explicit hover / walker mode', () => {
    for (const mode of ['hover', 'walker'] as const) {
      const res = validateClientMessage({ ...baseInput, mode });
      expect(res.ok).toBe(true);
      if (res.ok && res.msg.type === 'input') expect(res.msg.mode).toBe(mode);
    }
  });

  it('rejects an unknown mode string', () => {
    const res = validateClientMessage({ ...baseInput, mode: 'jetpack' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('input: invalid mode');
  });

  it('rejects a non-string mode', () => {
    const res = validateClientMessage({ ...baseInput, mode: 5 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('input: invalid mode');
  });
});
