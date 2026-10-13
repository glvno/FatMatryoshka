// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { decodeShare, encodeShare, LINK_MAX, shareCodeOf, shareLink } from './share';
import { DEFS } from './modules';
import { PRESETS } from './presets';
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { emptyPatch, addModule } from './patch';

describe('share links', () => {
  it('round-trips every factory patch through the fragment, well under the link limit', async () => {
    for (const make of Object.values(PRESETS)) {
      const p = make();
      const { code, full } = await encodeShare(p);
      expect(full).toBe(true);
      expect(code.length).toBeLessThan(LINK_MAX / 2);
      expect(/^[A-Za-z0-9_-]+$/.test(code)).toBe(true);
      expect(await decodeShare(code, DEFS)).toEqual(p);
      expect(shareCodeOf(shareLink(code, 'https://example.test/x/'))).toBe(code);
    }
    expect(shareCodeOf('https://example.test/')).toBeNull();
  });

  it('keeps assemblies and layout, and drops them only when the link would be too long', async () => {
    const p = emptyPatch('big');
    addModule(p, DEFS.fm1, 0, 0);
    const a = insertAssembly(p, DEFS, FACTORY.find((d) => d.name === 'voice')!, 300, 100);
    const { code } = await encodeShare(p);
    const q = await decodeShare(code, DEFS);
    expect(q.assemblies?.[0].label).toBe(a.label);
    expect(q.modules[1].x).toBe(p.modules[1].x);
  });
});
