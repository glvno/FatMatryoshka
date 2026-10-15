// SPDX-License-Identifier: GPL-3.0-only
// The plugin has one public entry point and does not ship TypeScript declarations.
declare module 'markdown-it-footnote' {
  import type { MarkdownIt } from 'markdown-it';
  export default function footnote(markdown: MarkdownIt): void;
}
