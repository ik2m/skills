#!/usr/bin/env node
// HTML -> PNG, with layout checks and a numbered contact sheet.
//
//   node render.mjs --spec spec.json --in <dir|file.html> [--texts texts.json] [--out <dir>] [--scale 1] [--label 2] [--no-sheet]
//
// --in dir   : renders every *.html in it (natural order), writes <out>/<name>.png,
//              <out>/report.json and <dir>/sheet.png (all candidates side by side).
// --in file  : renders one file (use for the final export, e.g. --scale 2).
// --label    : prefix for sheet captions ("2" -> 2-1 ... 2-8). Default: digits in the dir name.
//
// spec.json: { "width": 1080, "height": 1350, "safe": {"top":0,"right":0,"bottom":0,"left":0},
//              "minFontPx": 24, "previewWidth": 360, "background": "#ffffff" }
// Only width/height are required. Coordinates are CSS px at scale 1.
//
// texts.json (optional; default: next to spec.json, or --texts <file>): the copy agreed with the user.
//   { "texts": [ { "id": "date", "text": "受付開始 ◯月◯日", "priority": 2, "edit": "fixed", "optional": false } ] }
//   edit: "fixed" (verbatim) | "shorten" (characters may only be removed) | "rephrase" (free wording)
//   HTML marks where each text is placed with data-text="<id>", and placeholders with data-placeholder.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  // Cloud sessions resolve the preinstalled Playwright globally; locally it may live elsewhere.
  ({ chromium } = await import('playwright'));
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};

const specPath = opt('spec');
const input = opt('in');
if (!specPath || !input) {
  console.error('usage: render.mjs --spec spec.json --in <dir|file.html> [--texts texts.json] [--out dir] [--scale 1] [--label N] [--no-sheet]');
  process.exit(2);
}
const spec = JSON.parse(readFileSync(resolve(specPath), 'utf8'));
if (!Number.isFinite(spec.width) || !Number.isFinite(spec.height)) throw new Error('spec.width and spec.height are required');
const safe = { top: 0, right: 0, bottom: 0, left: 0, ...(spec.safe ?? {}) };
const scale = Number(opt('scale', '1'));

const EDITS = ['fixed', 'shorten', 'rephrase'];
const textsPath = resolve(opt('texts', join(dirname(resolve(specPath)), 'texts.json')));
let texts = null;
if (existsSync(textsPath)) {
  const raw = JSON.parse(readFileSync(textsPath, 'utf8'));
  texts = raw?.texts;
  if (!Array.isArray(texts) || texts.length === 0) throw new Error(`${textsPath}: "texts" must be a non-empty array`);
  const ids = new Set();
  for (const t of texts) {
    if (typeof t?.id !== 'string' || !t.id) throw new Error(`${textsPath}: every text needs a string "id"`);
    if (ids.has(t.id)) throw new Error(`${textsPath}: duplicate id "${t.id}"`);
    ids.add(t.id);
    if (typeof t.text !== 'string' || !t.text.trim()) throw new Error(`${textsPath}: "${t.id}" needs a non-empty "text"`);
    if (!Number.isFinite(t.priority)) throw new Error(`${textsPath}: "${t.id}" needs a numeric "priority" (1 = seen first)`);
    if (!EDITS.includes(t.edit)) throw new Error(`${textsPath}: "${t.id}".edit must be one of ${EDITS.join(', ')}`);
  }
}

const inPath = resolve(input);
const isDir = statSync(inPath).isDirectory();
const files = isDir
  ? readdirSync(inPath)
      .filter((f) => f.endsWith('.html') && f !== 'sheet.html')
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((f) => join(inPath, f))
  : [inPath];
if (files.length === 0) throw new Error(`no .html files in ${inPath}`);
const outDir = resolve(opt('out', isDir ? join(inPath, 'png') : dirname(inPath)));
mkdirSync(outDir, { recursive: true });

// Runs in the page. Reports what a human would otherwise only notice by squinting:
// text cut off, text in the platform's covered zones, too-small text, fallback fonts.
function inspect({ width, height, safe, minFontPx }) {
  const issues = [];
  const where = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const snippet = (s) => (s.length > 20 ? `${s.slice(0, 20)}…` : s);

  // No whole-page overflow check: decorations often bleed past the edge on purpose. Text off the canvas is caught per text node below.
  const headingPx = Math.max(56, (minFontPx ?? 0) * 1.8);

  // Without lang="ja", Chromium ignores word-break: auto-phrase and picks CJK glyph variants by guesswork.
  if (/[぀-ヿ一-鿿]/.test(document.body.textContent) && !document.documentElement.lang.startsWith('ja')) {
    issues.push({ type: 'missing-lang', detail: 'Japanese text but <html lang="ja"> is not set (line breaking and glyphs may be wrong)' });
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  const families = new Set();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (!text) continue;
    const el = node.parentElement;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) continue;
    families.add(cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, ''));

    const fontPx = parseFloat(cs.fontSize);
    if (minFontPx && fontPx < minFontPx && !el.closest('[data-small-ok]')) {
      issues.push({ type: 'small-text', where: where(el), text: snippet(text), detail: `${fontPx}px < ${minFontPx}px` });
    }
    // A single text node on several lines means the browser chose the break. In large Japanese headings that
    // lands mid-word (はじま／りました) even when the author placed <br>s, because a line was too long to fit.
    const lineTops = new Set(rects.map((r) => Math.round(r.top / 4)));
    if (fontPx >= headingPx && lineTops.size > 1 && !el.closest('[data-wrap-ok]')) {
      issues.push({ type: 'auto-wrap', where: where(el), text: snippet(text), detail: `${fontPx}px heading text wrapped onto ${lineTops.size} lines by the browser` });
    }
    const box = {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
    if (box.left < -0.5 || box.top < -0.5 || box.right > width + 0.5 || box.bottom > height + 0.5) {
      issues.push({ type: 'off-canvas', where: where(el), text: snippet(text) });
    } else if (
      !el.closest('[data-outside-safe-ok]') &&
      (box.left < safe.left || box.top < safe.top || box.right > width - safe.right || box.bottom > height - safe.bottom)
    ) {
      issues.push({ type: 'outside-safe-area', where: where(el), text: snippet(text), detail: `text box ${Math.round(box.left)},${Math.round(box.top)}-${Math.round(box.right)},${Math.round(box.bottom)}` });
    }

    // Clipped by an ancestor with overflow hidden (the classic "last line silently cut" bug).
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      if (seen.has(a)) break;
      const acs = getComputedStyle(a);
      if (acs.overflow !== 'visible' || acs.overflowX !== 'visible' || acs.overflowY !== 'visible') {
        seen.add(a);
        if (a.scrollHeight > a.clientHeight + 1 || a.scrollWidth > a.clientWidth + 1) {
          issues.push({ type: 'clipped', where: where(a), text: snippet(a.textContent.trim()), detail: `content ${a.scrollWidth}x${a.scrollHeight} in box ${a.clientWidth}x${a.clientHeight}` });
        }
      }
    }
  }

  const loaded = new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/^["']|["']$/g, '')));
  const failed = [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family);
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);
  for (const fam of families) {
    if (!generic.has(fam) && !loaded.has(fam)) {
      issues.push({ type: 'font-not-loaded', detail: `"${fam}" was not loaded as a web font; text may be in a fallback font unless it is installed locally` });
    }
  }
  for (const fam of failed) issues.push({ type: 'font-error', detail: `failed to load "${fam}"` });

  const broken = [...document.images].filter((img) => !img.complete || img.naturalWidth === 0).map((img) => img.getAttribute('src'));
  for (const src of broken) issues.push({ type: 'image-missing', detail: src });

  return { issues, fonts: [...loaded] };
}

// Runs in the page. Holds every candidate to the copy agreed in texts.json, so wording drift between
// rounds (a changed date, a reworded shop name, an invented claim) is caught mechanically.
function inspectTexts(texts) {
  const issues = [];
  const norm = (s) => s.replace(/\s+/g, '');
  const snippet = (s) => (s.length > 20 ? `${s.slice(0, 20)}…` : s);
  const visible = (el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && el.getClientRects().length > 0;
  };
  // "shorten" allows dropping characters but not adding or reordering them.
  const isSubsequence = (short, long) => {
    let i = 0;
    for (const ch of long) if (ch === short[i]) i++;
    return i === short.length;
  };
  const maxFontPx = (els) => {
    let px = 0;
    for (const el of els) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.textContent.trim()) px = Math.max(px, parseFloat(getComputedStyle(n.parentElement).fontSize));
      }
    }
    return px;
  };

  const defs = new Map(texts.map((t) => [t.id, t]));
  const marked = [...document.querySelectorAll('[data-text]')].filter(visible);
  for (const el of marked) {
    if (!defs.has(el.dataset.text)) issues.push({ type: 'text-unknown-id', detail: `data-text="${el.dataset.text}" is not defined in texts.json` });
  }

  const placed = [];
  for (const t of texts) {
    // Nested elements with the same id would count the same characters twice.
    const els = marked.filter((el) => el.dataset.text === t.id && !el.parentElement?.closest(`[data-text="${CSS.escape(t.id)}"]`));
    const shown = norm(els.map((el) => el.innerText).join(''));
    if (!shown) {
      if (!t.optional) issues.push({ type: 'text-missing', detail: `"${t.id}" 「${snippet(t.text)}」 is not on the image (mark it with data-text="${t.id}")` });
      continue;
    }
    const want = norm(t.text);
    if (t.edit === 'fixed' && shown !== want) {
      issues.push({ type: 'text-changed', detail: `"${t.id}" is fixed: must be 「${t.text}」 but shows 「${shown}」` });
    } else if (t.edit === 'shorten' && !isSubsequence(shown, want)) {
      issues.push({ type: 'text-reworded', detail: `"${t.id}" may only be shortened from 「${t.text}」 but shows 「${shown}」` });
    }
    placed.push({ id: t.id, priority: t.priority, px: maxFontPx(els) });
  }

  // Font size is only a proxy for where the eye goes (colour, position and contrast matter too), so this is a prompt to look, not a verdict.
  for (const a of placed) {
    for (const b of placed) {
      if (a.priority < b.priority && b.px > a.px + 0.5) {
        issues.push({ type: 'priority-inverted', detail: `"${b.id}" (priority ${b.priority}, ${b.px}px) is larger than "${a.id}" (priority ${a.priority}, ${a.px}px)` });
      }
    }
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.trim();
    const el = n.parentElement;
    if (!text || !el || el.closest('[data-text], [data-placeholder], style, script') || !visible(el)) continue;
    // Separators and ornaments (・ ／ ★) between agreed texts carry no wording of their own.
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    issues.push({ type: 'text-untracked', detail: `「${snippet(text)}」 is not in texts.json (add it, or mark a placeholder with data-placeholder)` });
  }
  return issues;
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: spec.width, height: spec.height }, deviceScaleFactor: scale });
const report = [];
for (const file of files) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
  await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => (img.complete ? null : img.decode().catch(() => null))));
  });
  const result = await page.evaluate(inspect, { width: spec.width, height: spec.height, safe, minFontPx: spec.minFontPx });
  const png = join(outDir, `${basename(file, '.html')}.png`);
  await page.screenshot({ path: png, clip: { x: 0, y: 0, width: spec.width, height: spec.height } });
  if (texts) result.issues.push(...(await page.evaluate(inspectTexts, texts)));
  for (const e of errors) result.issues.push({ type: 'page-error', detail: e });
  report.push({ file: basename(file), png, ...result });
  await page.close();
}

writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));

let sheetPath = null;
if (isDir && !flag('no-sheet')) {
  const label = opt('label', (basename(inPath).match(/\d+/) ?? [''])[0]);
  const pw = spec.previewWidth ?? Math.min(360, spec.width);
  const ph = Math.round((pw * spec.height) / spec.width);
  const cols = Math.min(4, report.length);
  const cells = report
    .map((r) => {
      const name = basename(r.file, '.html');
      const cap = label ? `${label}-${name}` : name;
      const warn = r.issues.length ? `<span class="warn">要確認 ${r.issues.length}</span>` : '';
      return `<figure><img src="${pathToFileURL(r.png).href}"><figcaption><b>${cap}</b>${warn}</figcaption></figure>`;
    })
    .join('');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:24px;background:#e9e9ec;font:600 20px system-ui,"IPAGothic",sans-serif;color:#222}
    .grid{display:grid;grid-template-columns:repeat(${cols},${pw}px);gap:24px}
    figure{margin:0} img{display:block;width:${pw}px;height:${ph}px;object-fit:contain;background:${spec.background ?? '#fff'};box-shadow:0 1px 4px rgba(0,0,0,.25)}
    figcaption{display:flex;gap:10px;align-items:center;margin-top:8px} .warn{font-size:14px;color:#b3261e}
  </style><div class="grid">${cells}</div>`;
  const sheetHtml = join(inPath, 'sheet.html');
  writeFileSync(sheetHtml, html);
  const page = await browser.newPage({ viewport: { width: cols * pw + (cols - 1) * 24 + 48, height: 400 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(sheetHtml).href, { waitUntil: 'load' });
  sheetPath = join(inPath, 'sheet.png');
  await page.screenshot({ path: sheetPath, fullPage: true });
  await page.close();
}
await browser.close();

for (const r of report) {
  console.log(`${r.file}: ${r.issues.length ? `${r.issues.length} issue(s)` : 'ok'}`);
  for (const i of r.issues) console.log(`  - ${i.type}${i.where ? ` ${i.where}` : ''}${i.text ? ` 「${i.text}」` : ''}${i.detail ? `: ${i.detail}` : ''}`);
}

// The fix for each issue type lives here, next to the check, so SKILL.md does not need to list them.
const HOW_TO_FIX = {
  clipped: '枠に収まらず文字が切れている。枠を広げるか、文字を小さく・短くする',
  'off-canvas': '文字が画像の外にはみ出している。位置か大きさを直す',
  'outside-safe-area': '文字がセーフエリアの外にある。内側に寄せる（わざと端に置く飾り文字なら data-outside-safe-ok）',
  'small-text': '文字が minFontPx より小さく、縮小表示で読めない。大きくする（小さくてよい注記なら data-small-ok）',
  'auto-wrap': '大きな見出しをブラウザが勝手に折り返した（「はじま／りました」になりやすい）。<br> の位置を直すか、文字を小さく・短くする（任せてよいなら data-wrap-ok）',
  'font-not-loaded': '指定したフォントが読み込まれず、別のフォントで表示されている。Google Fonts の family 名の綴りと、そのフォントにある太さ（wght）を指定しているか確かめる',
  'font-error': 'フォントの読み込みに失敗した。URL とネットワークを確かめる',
  'image-missing': '写真が読み込めていない。assets/ への相対パスを確かめる',
  'missing-lang': '<html lang="ja"> がない。付けないと日本語の改行と字形がおかしくなる',
  'page-error': 'ページの読み込み中にエラーが出た。内容を確かめる',
  'text-missing': '必須のテキストが載っていない。載せるか、ユーザーに確かめて texts.json で optional にする',
  'text-changed': 'fixed のテキストが一字一句同じでない。texts.json のとおりに戻す',
  'text-reworded': 'shorten のテキストは文字を削ることしかできない。言い換えや追加をやめる',
  'priority-inverted': '優先順位の低いテキストのほうが文字が大きい。色や位置で優先順位を表しているなら問題ないので、目で確かめる',
  'text-untracked': 'texts.json にない文字が載っている。事実を足していないか確かめ、必要ならユーザーに確かめて texts.json に加える（仮の枠の文字なら data-placeholder）',
  'text-unknown-id': 'data-text の id が texts.json にない。綴りを直すか texts.json に加える',
};
const seenTypes = [...new Set(report.flatMap((r) => r.issues.map((i) => i.type)))];
if (seenTypes.length) {
  console.log('\n直し方:');
  for (const t of seenTypes) console.log(`  ${t}: ${HOW_TO_FIX[t] ?? '内容を確かめる'}`);
}
console.log('');
if (sheetPath) console.log(`sheet: ${sheetPath}`);
if (texts) console.log(`texts: ${textsPath}`);
console.log(`report: ${join(outDir, 'report.json')}`);
