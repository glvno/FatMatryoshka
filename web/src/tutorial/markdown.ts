// SPDX-License-Identifier: GPL-3.0-only
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';

// One renderer for authored prose in both the live course and the writing preview.
// HTML stays literal; markdown-it escapes text/attributes and rejects unsafe URL schemes.
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false, typographer: false }).use(footnote);
// Repeated references keep the same number; their separate return links remain distinct.
markdown.renderer.rules.footnote_caption = (tokens, index) => `[${Number(tokens[index].meta!.id) + 1}]`;
for (const rule of ['footnote_ref', 'footnote_anchor']) {
  const render = markdown.renderer.rules[rule];
  markdown.renderer.rules[rule] = (tokens, index, options, env, renderer) => {
    const n = Number(tokens[index].meta!.id) + 1;
    const reference = Number(tokens[index].meta!.subId ?? 0) + 1;
    const label = rule === 'footnote_ref' ? `Footnote ${n}` : `Back to reference ${reference} for footnote ${n}`;
    return render(tokens, index, options, env, renderer).replace('<a ', `<a aria-label="${label}" `);
  };
}
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
// A link to `req:id[,id…]` is a requirement placed in the text: a checkbox around the author's words, ticked by the panel.
const REQ = /^req:([a-z0-9][a-z0-9-]*(?:,[a-z0-9][a-z0-9-]*)*)$/;
markdown.core.ruler.push('req', (state) => {
  for (const block of state.tokens) {
    const open: boolean[] = [];
    for (const t of block.children ?? []) {
      if (t.type === 'link_open') {
        const m = REQ.exec(String(t.attrGet('href') ?? ''));
        open.push(!!m);
        if (m) { t.type = 'req_open'; t.tag = 'span'; t.attrs = [['class', 'req'], ['data-req', m[1]]]; }
      } else if (t.type === 'link_close' && open.pop()) { t.type = 'req_close'; t.tag = 'span'; }
    }
  }
});
markdown.renderer.rules.req_open = (tokens, index) =>
  `<span class="req" data-req="${markdown.utils.escapeHtml(String(tokens[index].attrGet('data-req') ?? ''))}"><span class="req-box" aria-hidden="true"></span><span class="req-text">`;
markdown.renderer.rules.req_close = () => '</span></span>';

/** the requirement ids the text places, one list per checkbox, in reading order */
export function placedRequirements(source: string): string[][] {
  const out: string[][] = [];
  const walk = (tokens: ReturnType<typeof markdown.parse>) => {
    for (const t of tokens) {
      if (t.type === 'req_open') out.push(String(t.attrGet('data-req') ?? '').split(','));
      if (t.children) walk(t.children);
    }
  };
  walk(markdown.parse(source, {}));
  return out;
}

// The lesson title is h2; prose headings start below it, even when written as #.
for (const rule of ['heading_open', 'heading_close']) {
  markdown.renderer.rules[rule] = (tokens, index, options, _env, renderer) => {
    tokens[index].tag = `h${Math.min(6, Number(tokens[index].tag.slice(1)) + 2)}`;
    return renderer.renderToken(tokens, index, options);
  };
}

let proseId = 0;
export function renderLessonMarkdown(source: string): string {
  // Instructions, Why and challenges can coexist and each may contain [^1].
  // IDs never include authored labels, and no two rendered fields share an anchor.
  return markdown.render(source, { docId: `lesson-${++proseId}` });
}

export function lessonProse(source: string): HTMLDivElement {
  const prose = document.createElement('div');
  prose.className = 'tutorial-prose';
  // Only parser-generated HTML reaches this sink. Raw HTML is disabled above.
  prose.innerHTML = renderLessonMarkdown(source);
  prose.querySelector('.footnotes')?.setAttribute('aria-label', 'Footnotes');
  prose.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.footnote-ref a, a.footnote-backref') : null;
    if (!link) return;
    // The app uses URL fragments for patches and tabs. Footnotes navigate only inside this field.
    event.preventDefault();
    const target = prose.ownerDocument.getElementById(link.hash.slice(1));
    if (!target || !prose.contains(target)) return;
    if (!target.matches('a[href]')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  // Keep wide tables usable without widening or scrolling the whole lesson card.
  for (const table of prose.querySelectorAll('table')) {
    const scroll = document.createElement('div');
    scroll.className = 'tutorial-table'; scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Scrollable table');
    table.replaceWith(scroll); scroll.append(table);
  }
  for (const img of prose.querySelectorAll('img')) { img.loading = 'lazy'; img.decoding = 'async'; }
  return prose;
}

export function lessonChallenge(source: string): HTMLDivElement {
  const section = document.createElement('div');
  section.className = 'tutorial-challenge';
  const label = document.createElement('strong'); label.textContent = 'Optional challenge';
  section.append(label, lessonProse(source));
  return section;
}
