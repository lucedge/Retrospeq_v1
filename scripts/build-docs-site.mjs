#!/usr/bin/env node
// Builds the browsable developer-documentation site from the markdown in
// `docs/` — one self-contained HTML file, no framework, no runtime fetch.
//
// Why it is built this way:
//   * The markdown in the repo stays the source of truth. This output is
//     derived and gitignored, so the site can never silently disagree with
//     what is committed.
//   * Mermaid blocks are emitted as `<pre class="mermaid">`, which the
//     Artifact viewer renders natively — no mermaid bundle to ship, pin or
//     keep current. For local viewing the same file loads mermaid from a
//     CDN, so `open docs/site/index.html` works too.
//   * The output is NEVER written to `public/`. These pages describe the
//     RLS model and the service-role allowlist; `public/` is served on the
//     production domain.
//
// Usage: npm run docs:build
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'docs/site.manifest.json'), 'utf8'));

/** Mermaid fences must survive markdown rendering as `<pre class="mermaid">`
 *  rather than a highlighted code block. */
const renderer = new marked.Renderer();
const baseCode = renderer.code.bind(renderer);
renderer.code = (token) => {
  const lang = token.lang ?? '';
  const text = token.text ?? '';
  if (lang.trim().split(/\s+/)[0] === 'mermaid') {
    return `<pre class="mermaid">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</pre>`;
  }
  return baseCode(token);
};
marked.setOptions({ renderer, gfm: true, breaks: false });

const slug = (p) => p.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let nav = '';
let body = '';
let pageCount = 0;
const missing = [];

for (const section of manifest.sections) {
  nav += `<div class="nav-group"><p class="nav-group__title">${esc(section.group)}</p><ul>`;
  for (const page of section.pages) {
    const abs = join(root, page.path);
    const id = slug(page.path);
    if (!existsSync(abs)) {
      missing.push(page.path);
      nav += `<li><span class="nav-link nav-link--pending" title="not written yet">${esc(page.title)}</span></li>`;
      continue;
    }
    pageCount++;
    nav += `<li><a class="nav-link" href="#${id}" data-target="${id}">${esc(page.title)}</a></li>`;
    // Rewrite in-repo relative links to in-page anchors where the target is
    // also on the site; anything else is left alone and simply won't resolve
    // offline, which is honest.
    let md = readFileSync(abs, 'utf8');
    for (const s of manifest.sections) {
      for (const p of s.pages) {
        const file = p.path.split('/').pop();
        md = md.replaceAll(`](${p.path})`, `](#${slug(p.path)})`).replaceAll(`](./${file})`, `](#${slug(p.path)})`);
      }
    }
    // Inline local SVGs: a relative <img src> would not resolve from the
    // single-file output, and these diagrams are the point of the page.
    md = md.replace(/!\[([^\]]*)\]\(([^)]+\.svg)\)/g, (whole, alt, src) => {
      const svgPath = join(dirname(abs), src);
      if (!existsSync(svgPath)) return whole;
      const svg = readFileSync(svgPath, 'utf8')
        .replace(/<\?xml[^>]*\?>/g, '')
        .replace(/<!DOCTYPE[^>]*>/gi, '');
      return `<figure class="figure">${svg}<figcaption>${alt}</figcaption></figure>`;
    });

    body += `<article class="page" id="${id}" data-page="${id}">
      <p class="page__crumb">${esc(section.group)}</p>
      <p class="page__blurb">${esc(page.blurb)}</p>
      <div class="prose">${marked.parse(md)}</div>
      <p class="page__source">Source: <code>${esc(page.path)}</code></p>
    </article>`;
  }
  nav += '</ul></div>';
}

const html = `<title>${esc(manifest.title)}</title>
<style>
  :root {
    --bg:#f6f6f4; --surface:#fff; --ink:#16150f; --ink-soft:#4a4740; --ink-faint:#8b877c;
    --line:#e3e0d8; --accent:#e09b3d; --accent-ink:#8a5a12; --radius:12px;
    --sans:"Archivo",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    --mono:"Azeret Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
    color-scheme:light;
  }
  :root:not([data-theme="light"]) { }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg:#131311; --surface:#1b1b18; --ink:#f2f0ea; --ink-soft:#c4c0b6; --ink-faint:#8b877c;
      --line:#2e2d28; --accent:#e09b3d; --accent-ink:#f0b962; color-scheme:dark;
    }
  }
  :root[data-theme="dark"] {
    --bg:#131311; --surface:#1b1b18; --ink:#f2f0ea; --ink-soft:#c4c0b6; --ink-faint:#8b877c;
    --line:#2e2d28; --accent:#e09b3d; --accent-ink:#f0b962; color-scheme:dark;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans); line-height:1.65; }
  .shell { display:flex; min-height:100vh; }
  .side { width:280px; flex:0 0 280px; border-right:1px solid var(--line); background:var(--surface);
          position:sticky; top:0; height:100vh; overflow-y:auto; padding:22px 18px 40px; }
  .brand { font-weight:700; letter-spacing:-.01em; font-size:15px; margin:0 0 2px; }
  .brand span { color:var(--accent-ink); }
  .side__sub { margin:0 0 18px; font-size:12px; color:var(--ink-faint); line-height:1.45; }
  .search { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px;
            background:var(--bg); color:var(--ink); font:inherit; font-size:13px; margin-bottom:16px; }
  .nav-group { margin-bottom:16px; }
  .nav-group__title { margin:0 0 6px; font-family:var(--mono); font-size:10.5px; letter-spacing:.09em;
                      text-transform:uppercase; color:var(--ink-faint); }
  .side ul { list-style:none; margin:0; padding:0; }
  .nav-link { display:block; padding:5px 8px; border-radius:7px; font-size:13.5px;
              color:var(--ink-soft); text-decoration:none; }
  .nav-link:hover { background:var(--bg); color:var(--ink); }
  .nav-link.is-active { background:color-mix(in srgb, var(--accent) 16%, transparent); color:var(--accent-ink); font-weight:600; }
  .nav-link--pending { display:block; padding:5px 8px; font-size:13.5px; color:var(--ink-faint); opacity:.5; cursor:default; }
  .nav-link--pending::after { content:" · to come"; font-size:10.5px; font-family:var(--mono); }
  .main { flex:1; min-width:0; display:flex; justify-content:center; padding:40px 40px 120px; }
  .page { display:none; width:100%; max-width:780px; }
  .page.is-visible { display:block; }
  .page__crumb { font-family:var(--mono); font-size:10.5px; letter-spacing:.09em; text-transform:uppercase;
                 color:var(--ink-faint); margin:0 0 6px; }
  .page__blurb { margin:0 0 26px; color:var(--ink-soft); font-size:15px; }
  .page__source { margin-top:48px; padding-top:14px; border-top:1px solid var(--line);
                  font-size:12px; color:var(--ink-faint); }
  .prose h1 { font-size:30px; letter-spacing:-.02em; margin:0 0 18px; }
  .prose h2 { font-size:21px; letter-spacing:-.01em; margin:38px 0 12px; padding-top:14px; border-top:1px solid var(--line); }
  .prose h3 { font-size:16.5px; margin:26px 0 8px; }
  .prose p, .prose li { font-size:15px; color:var(--ink-soft); }
  .prose strong { color:var(--ink); }
  .prose a { color:var(--accent-ink); text-underline-offset:2px; }
  .prose code { font-family:var(--mono); font-size:12.5px; background:var(--surface);
                border:1px solid var(--line); border-radius:5px; padding:1px 5px; color:var(--ink); }
  .prose pre { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius);
               padding:14px 16px; overflow-x:auto; }
  .prose pre code { background:none; border:none; padding:0; font-size:12.5px; line-height:1.55; }
  .prose pre.mermaid { background:var(--surface); text-align:center; padding:18px; }
  .prose table { border-collapse:collapse; width:100%; margin:16px 0; font-size:13.5px; display:block; overflow-x:auto; }
  .prose th, .prose td { border:1px solid var(--line); padding:7px 10px; text-align:left; vertical-align:top; }
  .prose th { background:var(--surface); font-size:12px; letter-spacing:.02em; color:var(--ink); }
  .prose blockquote { margin:16px 0; padding:2px 0 2px 16px; border-left:2px solid var(--accent);
                      color:var(--ink-soft); }
  .prose img { max-width:100%; }
  .figure { margin:20px 0; padding:16px; background:var(--surface); border:1px solid var(--line);
            border-radius:var(--radius); text-align:center; }
  .figure svg { max-width:100%; height:auto; }
  .figure figcaption { margin-top:10px; font-size:12.5px; color:var(--ink-faint); text-align:left; }
  .prose hr { border:none; border-top:1px solid var(--line); margin:28px 0; }
  .theme { position:fixed; top:14px; right:18px; border:1px solid var(--line); background:var(--surface);
           color:var(--ink-soft); border-radius:8px; padding:6px 11px; font:inherit; font-size:12px; cursor:pointer; }
  .empty { color:var(--ink-faint); font-size:14px; }
  @media (max-width:900px) {
    .shell { flex-direction:column; }
    .side { position:static; width:auto; height:auto; flex:none; border-right:none; border-bottom:1px solid var(--line); }
    .main { padding:24px 18px 80px; }
  }
</style>

<div class="shell">
  <aside class="side">
    <p class="brand">Retrospeq <span>·</span> dev docs</p>
    <p class="side__sub">${esc(manifest.subtitle)}</p>
    <input class="search" type="search" placeholder="Filter pages…" aria-label="Filter pages">
    <nav>${nav}</nav>
  </aside>
  <main class="main">${body || '<p class="empty">No pages written yet.</p>'}</main>
</div>
<button class="theme" type="button">Theme</button>

<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script>
  // The Artifact viewer renders <pre class="mermaid"> natively. When opened
  // as a local file the CDN copy above does it instead; if neither is
  // available the diagram source stays readable as text, which is the point
  // of keeping it as text.
  try {
    if (window.mermaid) {
      const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
      window.mermaid.initialize({ startOnLoad: true, theme: dark ? 'dark' : 'neutral', securityLevel: 'strict' });
    }
  } catch {}

  const links = [...document.querySelectorAll('.nav-link')];
  const pages = [...document.querySelectorAll('.page')];
  function show(id) {
    const target = pages.find((p) => p.dataset.page === id) ?? pages[0];
    if (!target) return;
    pages.forEach((p) => p.classList.toggle('is-visible', p === target));
    links.forEach((a) => a.classList.toggle('is-active', a.dataset.target === target.dataset.page));
    document.querySelector('.main').scrollTo?.(0, 0);
    window.scrollTo(0, 0);
  }
  links.forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); location.hash = a.dataset.target; }));
  addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1) || (pages[0] && pages[0].dataset.page));

  document.querySelector('.search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    links.forEach((a) => {
      const hit = !q || a.textContent.toLowerCase().includes(q);
      a.parentElement.style.display = hit ? '' : 'none';
    });
  });

  document.querySelector('.theme').addEventListener('click', () => {
    const now = document.documentElement.dataset.theme;
    const next = now === 'dark' ? 'light' : now === 'light' ? '' : 'dark';
    if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme;
  });
</script>`;

mkdirSync(join(root, 'docs/site'), { recursive: true });
writeFileSync(join(root, 'docs/site/index.html'), html);
console.log(`docs site: ${pageCount} page(s) written to docs/site/index.html`);
if (missing.length) console.log(`  not written yet (${missing.length}): ${missing.join(', ')}`);
