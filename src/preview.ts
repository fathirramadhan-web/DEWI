export function buildPreviewHtml(): string {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DEWI Gallery</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f8f8f6;
    --card: #ffffff;
    --ink: #15181e;
    --muted: #64748b;
    --line: #e2e8f0;
    --accent: #2563eb;
  }
  :root[data-theme='dark'] {
    color-scheme: dark;
    --bg: #0c0f14;
    --card: #151922;
    --ink: #f1f5f9;
    --muted: #94a3b8;
    --line: #232a36;
    --accent: #60a5fa;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0 24px 80px;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  }
  header {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: baseline;
    gap: 16px;
    max-width: 1180px;
    margin: 0 auto;
    padding: 24px 0 18px;
    background: linear-gradient(var(--bg) 75%, transparent);
  }
  h1 { margin: 0; font-size: 20px; letter-spacing: -0.02em; }
  .meta { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .spacer { flex: 1; }
  button {
    font: inherit;
    font-size: 13px;
    color: var(--ink);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 6px 14px;
    cursor: pointer;
  }
  button[aria-pressed='true'] { border-color: var(--accent); }
  .tour { max-width: 1180px; margin: 0 auto 22px; }
  .tour video { width: 100%; border-radius: 12px; border: 1px solid var(--line); display: block; }
  main {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
    gap: 20px;
    max-width: 1180px;
    margin: 0 auto;
  }
  article {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    overflow: hidden;
  }
  .frame {
    position: relative;
    aspect-ratio: 16 / 9;
    background: #000;
    cursor: pointer;
  }
  .frame img, .frame video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .frame video { opacity: 0; transition: opacity 160ms ease; }
  .frame[data-playing='true'] video { opacity: 1; }
  .badge {
    position: absolute;
    right: 10px;
    bottom: 10px;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: #fff;
    background: rgba(0, 0, 0, 0.68);
  }
  .body { padding: 14px 16px 16px; }
  h2 { margin: 0 0 4px; font-size: 15.5px; }
  p { margin: 0; color: var(--muted); font-size: 13.5px; }
  .stills { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
  .stills a {
    font-size: 11.5px;
    color: var(--muted);
    text-decoration: none;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 3px 8px;
  }
  .stills a:hover { color: var(--ink); border-color: var(--ink); }
</style>
</head>
<body>
<header>
  <h1>DEWI Gallery</h1>
  <span class="meta" id="meta"></span>
  <span class="spacer"></span>
  <button id="theme" aria-pressed="false">Dark</button>
</header>
<div class="tour" id="tour"></div>
<main id="grid"></main>
<script type="module">
const manifest = await fetch('./manifest.json').then((r) => r.json());
let theme = manifest.themes?.[0] ?? 'dark';

const grid = document.getElementById('grid');
const tour = document.getElementById('tour');
const meta = document.getElementById('meta');
const themeBtn = document.getElementById('theme');

function syncThemeButton() {
  document.documentElement.dataset.theme = theme;
  themeBtn.textContent = theme === 'light' ? 'Dark' : 'Light';
  themeBtn.setAttribute('aria-pressed', String(theme === 'dark'));
}

meta.textContent = [
  manifest.scenes.length + ' scene(s)',
  manifest.themes.length + ' theme(s)',
  manifest.stage.video.width + 'x' + manifest.stage.video.height,
  manifest.stage.fps + 'fps',
  'filmed ' + manifest.filmedAt.slice(0, 10),
].join('  |  ');

function render() {
  syncThemeButton();
  tour.innerHTML = manifest.tours[theme]
    ? '<video src="' + manifest.tours[theme] + '" controls preload="metadata"></video>'
    : '';

  grid.replaceChildren(
    ...manifest.scenes.flatMap((scene) => {
      const assets = scene.assets[theme];
      if (!assets) return [];

      const card = document.createElement('article');
      card.innerHTML =
        '<div class="frame">' +
        '<img loading="lazy" src="' + (assets.stills[0] ?? assets.poster) + '" alt="">' +
        '<video loop playsinline preload="none" src="' + assets.mp4 + '"></video>' +
        '<span class="badge">' + assets.seconds.toFixed(1) + 's · ' + assets.fps.toFixed(0) + 'fps' +
        (assets.spoken ? ' · voice' : '') + '</span>' +
        '</div>' +
        '<div class="body">' +
        '<h2>' + scene.title + '</h2>' +
        '<p>' + scene.blurb + '</p>' +
        '<div class="stills">' +
        assets.stills.map((s) => '<a href="' + s + '" target="_blank">' + s.split('/').pop() + '</a>').join('') +
        '</div></div>';

      const frame = card.querySelector('.frame');
      const video = card.querySelector('video');
      const play = (audio) => {
        video.muted = !audio;
        frame.dataset.playing = 'true';
        video.play().catch(() => undefined);
      };
      const stop = () => {
        frame.dataset.playing = 'false';
        video.pause();
        video.currentTime = 0;
      };

      frame.addEventListener('mouseenter', () => play(false));
      frame.addEventListener('mouseleave', stop);
      frame.addEventListener('click', () => {
        if (frame.dataset.playing === 'true' && !video.muted) {
          stop();
        } else {
          play(true);
        }
      });

      return [card];
    })
  );
}

themeBtn.addEventListener('click', () => {
  theme = theme === 'light' ? 'dark' : 'light';
  render();
});

render();
</script>
</body>
</html>
`;
}
