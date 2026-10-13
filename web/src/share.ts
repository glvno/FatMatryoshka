// SPDX-License-Identifier: GPL-3.0-only
// A patch as a link: the JSON (layout and assemblies included) deflated and base64url-encoded in the URL fragment,
// `#p=…`. Opening such a link loads the patch into the editor without touching the saved one until the user acts.
// Too long for a link (over LINK_MAX characters): the card positions and the assembly overlay are dropped first.
import { validatePatch, type ModuleDef, type Patch } from './patch';

export const LINK_MAX = 8000;

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string): Uint8Array => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function deflate(text: string): Promise<string> {
  return b64url(await pipe(new TextEncoder().encode(text), new CompressionStream('deflate-raw')));
}

export async function inflate(code: string): Promise<string> {
  return new TextDecoder().decode(await pipe(unb64url(code), new DecompressionStream('deflate-raw')));
}

/** the fragment value for a patch; without positions and assemblies when the full form is too long for a link */
export async function encodeShare(p: Patch): Promise<{ code: string; full: boolean }> {
  const full = await deflate(JSON.stringify(p));
  if (full.length <= LINK_MAX) return { code: full, full: true };
  const slim: Patch = { ...p, modules: p.modules.map((m) => ({ ...m, x: 0, y: 0 })) };
  delete slim.assemblies;
  return { code: await deflate(JSON.stringify(slim)), full: false };
}

export async function decodeShare(code: string, defs: Record<string, ModuleDef>): Promise<Patch> {
  return validatePatch(JSON.parse(await inflate(code)), defs);
}

/** the `p` value of a link's fragment (`#p=…`), or null */
export function shareCodeOf(url: string): string | null {
  const i = url.indexOf('#');
  if (i < 0) return null;
  const m = /(?:^|&)p=([A-Za-z0-9_-]+)/.exec(url.slice(i + 1));
  return m ? m[1] : null;
}

export const shareLink = (code: string, base = location.href): string => `${base.split('#')[0]}#p=${code}`;
