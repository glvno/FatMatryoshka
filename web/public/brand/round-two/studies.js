const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const [wordmarks, { candidates: icons }] = await Promise.all([fetch('wordmarks.json').then(r => r.json()), fetch('prompts.json').then(r => r.json())]);
let word = wordmarks.find(w => w.id === params.get('wordmark')) ?? wordmarks[0];
let icon = icons.find(i => i.id === params.get('icon')) ?? icons[0];
const svg = new Map(await Promise.all(wordmarks.map(async w => [w.id, await fetch(w.file).then(r => r.text())])));
function el(tag, text, cls) { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; }
function wordArt(id, cls) { const n = el('div', '', cls); n.innerHTML = svg.get(id); return n; }
function card(item, type) {
 const article = el('article'); article.id = item.id; article.dataset.type = type;
 if (type === 'wordmark') { article.append(wordArt(item.id, 'word-art'), el('span', '175 px', 'size-caption'), wordArt(item.id, 'small-word')); }
 else { const art = el('div', '', 'art'), img = el('img'); img.src = `${item.id}.png`; img.alt = `${item.name}: ${item.description}`; img.loading = 'lazy'; art.append(img); article.append(art); }
 article.append(el('span', item.id.toUpperCase(), 'id'), el('h3', item.name), el('p', item.description), el('p', item.risk, 'risk'));
 const actions = el('div', '', 'actions'), tryIt = el('button', type === 'wordmark' ? 'Try wordmark' : 'Try icon');
 tryIt.setAttribute('aria-label', `Try ${item.name} ${type}`); tryIt.onclick = () => { if (type === 'wordmark') word = item; else icon = item; update(); };
 const download = el('a', type === 'wordmark' ? 'SVG' : 'PNG'); download.href = type === 'wordmark' ? item.file : `${item.id}.png`; download.download = ''; download.setAttribute('aria-label', `Download ${item.name}`);
 actions.append(tryIt, download); article.append(actions); return article;
}
$('wordmark-list').append(...wordmarks.map(w => card(w, 'wordmark')));
$('icon-list').append(...icons.map(i => card(i, 'icon')));
function update() {
 $('selected-icon').src = `${icon.id}.png`; $('selected-icon').alt = icon.name;
 $('selected-wordmark').replaceChildren(wordArt(word.id, ''));
 $('selection').textContent = `${word.id.toUpperCase()} ${word.name} + ${icon.id.slice(0,2)} ${icon.name}`;
 for (const article of document.querySelectorAll('article')) { const on = article.id === word.id || article.id === icon.id; article.classList.toggle('chosen', on); article.querySelector('button').setAttribute('aria-pressed', String(on)); }
 const next = new URL(location.href); next.searchParams.set('wordmark', word.id); next.searchParams.set('icon', icon.id); next.searchParams.set('theme', $('theme').value); history.replaceState(null, '', next);
}
$('theme').value = params.get('theme') === 'dark' ? 'dark' : 'light';
function theme() { document.documentElement.dataset.theme = $('theme').value; update(); }
$('theme').onchange = theme;
$('icon-size').oninput = () => { const size = $('icon-size').value; document.documentElement.style.setProperty('--study-size', `${size}px`); $('size-value').textContent = `${size} px`; };
$('copy').onclick = async () => { try { await navigator.clipboard.writeText(location.href); $('copy-status').textContent = 'Link copied.'; } catch { $('copy-status').textContent = location.href; } };
theme();
