// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { renderLessonMarkdown } from './markdown';

describe('lesson Markdown', () => {
  it('renders emphasis, nested formatting, strikethrough and literal control names', () => {
    const html = renderLessonMarkdown('Turn **cutoff** *slowly*. **Try *both*.** ~~Old~~ `Main gate`');
    expect(html).toContain('<strong>cutoff</strong>');
    expect(html).toContain('<em>slowly</em>');
    expect(html).toContain('<strong>Try <em>both</em>.</strong>');
    expect(html).toContain('<s>Old</s>');
    expect(html).toContain('<code>Main gate</code>');
  });
  it('renders paragraphs and single line breaks without losing existing prose', () => {
    expect(renderLessonMarkdown('One line.\nSecond line.\n\nNext paragraph.')).toBe('<p>One line.<br>\nSecond line.</p>\n<p>Next paragraph.</p>\n');
    expect(renderLessonMarkdown('Main gate → ADSR gate; “listen” at 0.5 Hz.')).toContain('Main gate → ADSR gate; “listen” at 0.5 Hz.');
  });
  it('renders lists, nested lists, headings, quotations and fenced code', () => {
    const html = renderLessonMarkdown('# Listen\n\n- Open the filter\n  - Try resonance\n- Close it\n\n1. Play\n2. Release\n\n> Hear the tail.\n\n```\nMain gate → ADSR gate\n```');
    expect(html).toContain('<h3>Listen</h3>');
    expect(html).not.toContain('<h1>');
    expect(html.match(/<ul>/g)).toHaveLength(2);
    expect(html).toContain('<ol>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<pre><code>Main gate → ADSR gate\n</code></pre>');
  });
  it('renders tables and opens links without replacing the learner’s patch', () => {
    const html = renderLessonMarkdown('| Control | Effect |\n| --- | --- |\n| cutoff | Brightness |\n\n[Read more](https://example.com/lesson?q=1&v=2)');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Control</th>');
    expect(html).toContain('href="https://example.com/lesson?q=1&amp;v=2"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  });
  it('treats raw HTML and code contents as text', () => {
    const html = renderLessonMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n`<b>literal</b>`\n\n```html\n<iframe src="bad"></iframe>\n```');
    expect(html).not.toMatch(/<(script|img|iframe|b)[\s>]/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<code>&lt;b&gt;literal&lt;/b&gt;</code>');
  });
  it.each(['javascript:alert(1)', 'java&#x73;cript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,bad', 'file:///tmp/private'])('rejects unsafe link and image URL %s', url => {
    const html = renderLessonMarkdown(`[go](${url}) ![image](${url})`);
    expect(html).not.toMatch(/<(a|img)\s/);
  });
  it('escapes image attributes and does not create event handlers', () => {
    const html = renderLessonMarkdown('![" onerror="alert(1)](https://example.com/image.png)');
    expect(html).toContain('alt="&quot; onerror=&quot;alert(1)"');
    expect(html).not.toContain(' onerror="');
  });
  it('does not keep parsing state between previews and handles unfinished syntax', () => {
    expect(renderLessonMarkdown('**Still writing')).toBe('<p>**Still writing</p>\n');
    expect(renderLessonMarkdown('[label]: https://example.com\n\n[label]')).toContain('<a ');
    expect(renderLessonMarkdown('[label]')).not.toContain('<a ');
    expect(renderLessonMarkdown('# Title')).toBe(renderLessonMarkdown('# Title'));
  });
  it('renders named and inline footnotes with formatted content and return links', () => {
    const html = renderLessonMarkdown('Hear the tail.[^tail] A quick aside.^[Try *both* settings.]\n\n[^tail]: Turn **release** up.\n\n    A second paragraph with `r`.');
    expect(html.match(/class="footnote-item"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Footnote 1"');
    expect(html).toContain('aria-label="Footnote 2"');
    expect(html).toContain('<strong>release</strong>');
    expect(html).toContain('<em>both</em>');
    expect(html).toContain('<p>A second paragraph with <code>r</code>.');
    expect(html).toContain('aria-label="Back to reference 1 for footnote 1"');
    expect(html).not.toContain('target="_blank"');
  });
  it('gives repeated references separate return links to one numbered note', () => {
    const html = renderLessonMarkdown('First.[^same] Again.[^same]\n\n[^same]: One explanation.');
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
    const links = [...html.matchAll(/href="#([^"]+)"/g)].map(m => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(links.every(id => ids.includes(id))).toBe(true);
    expect(html.match(/>\[1\]<\/a>/g)).toHaveLength(2);
    expect(html.match(/class="footnote-item"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Back to reference 2 for footnote 1"');
  });
  it('scopes footnote IDs to each rendered field and forgets old definitions', () => {
    const a = renderLessonMarkdown('Instructions.[^1]\n\n[^1]: First field.');
    const b = renderLessonMarkdown('Why.[^1]\n\n[^1]: Second field.');
    const ids = (html: string) => [...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
    expect(ids(a).some(id => ids(b).includes(id))).toBe(false);
    expect(renderLessonMarkdown('Unfinished.[^1]')).toBe('<p>Unfinished.[^1]</p>\n');
  });
  it('keeps HTML and unsafe links inert inside footnotes', () => {
    const html = renderLessonMarkdown('Note.[^evil]\n\n[^evil]: <script>bad</script> [bad](javascript:alert(1))');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
  });
});
