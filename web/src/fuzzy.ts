// SPDX-License-Identifier: GPL-3.0-only
/** fuzzy match for the palette and the assembly browser: every character of the query in order; a run of adjacent matches and a match at a word start score higher; -1 = no match */
export const score = (q: string, s: string): number => {
  s = s.toLowerCase();
  let i = 0,
    sc = 0,
    last = -2;
  for (const ch of q) {
    const j = s.indexOf(ch, i);
    if (j < 0) return -1;
    sc += j === last + 1 ? 3 : j === 0 || s[j - 1] === ' ' ? 2 : 1;
    last = j;
    i = j + 1;
  }
  return sc;
};
