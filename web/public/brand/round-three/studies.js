const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};

async function read(url, json = false) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load ${url}`);
  return json ? response.json() : response.text();
}

try {
  const studies = await read('wordmarks.json', true);
  const artwork = new Map(await Promise.all(studies.map(async study => [study.id, await read(study.file)])));
  let selected = studies.find(study => study.id === params.get('wordmark')) ?? studies[2];
  function art(id, className) {
    const node = element('div', '', className);
    node.innerHTML = artwork.get(id);
    return node;
  }
  function update() {
    $('selected-wordmark').replaceChildren(art(selected.id, ''));
    $('selection').textContent = `${selected.id.toUpperCase()} · ${selected.name}`;
    document.documentElement.dataset.theme = $('theme').value;
    for (const card of document.querySelectorAll('#wordmark-list article')) {
      const active = card.id === selected.id;
      card.classList.toggle('chosen', active);
      card.querySelector('button').setAttribute('aria-pressed', String(active));
    }
    const url = new URL(location.href);
    url.searchParams.set('wordmark', selected.id);
    url.searchParams.set('theme', $('theme').value);
    history.replaceState(null, '', url);
    $('copy-status').textContent = '';
  }
  for (const study of studies) {
    const card = element('article');
    card.id = study.id;
    card.append(art(study.id, 'word-art'), element('span', '175 px', 'size-caption'), art(study.id, 'small-word'), element('span', study.id.toUpperCase(), 'id'), element('h3', study.name), element('p', study.description));
    const settings = element('p', '', 'type-settings');
    for (const [name, axes] of [['FAT', study.fat], ['MATRYOSHKA', study.mat]]) {
      settings.append(element('span', `${name}: weight ${axes[0]} / width ${axes[1]} / optical size ${axes[2]}`));
    }
    const actions = element('div', '', 'actions');
    const button = element('button', 'Try wordmark');
    button.type = 'button';
    button.setAttribute('aria-label', `Try ${study.name}`);
    button.onclick = () => { selected = study; update(); };
    const download = element('a', 'Download SVG');
    download.href = study.file;
    download.download = '';
    download.setAttribute('aria-label', `Download ${study.name} SVG`);
    actions.append(button, download);
    card.append(settings, actions);
    $('wordmark-list').append(card);
  }
  $('theme').value = params.get('theme') === 'light' ? 'light' : 'dark';
  $('theme').onchange = update;
  $('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); $('copy-status').textContent = 'Link copied.'; }
    catch { $('copy-status').textContent = location.href; }
  };
  update();
  $('original-wordmark').innerHTML = await read('../round-two/w06.svg');
} catch (error) {
  $('selection').textContent = 'The studies could not load. Reload the page to try again.';
  console.error(error);
}
