import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, cpSync, lstatSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as upstream from './dist/upstream.mjs';
import { validateInputs } from './validate.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
export const UPSTREAM_COMMIT = '72384999ce9e902c0ab3222a481f7fd0931497e6';
const json = path => JSON.parse(readFileSync(resolve(path), 'utf8').replace(/^\uFEFF/, ''));
const digest = value => createHash('sha256').update(value).digest('hex');

function main() {
  const args = {};
  const allowed = new Set(['config', 'data', 'projects', 'icons', 'avatar', 'out']);
  for (let n = 2; n < process.argv.length; n += 2) {
    const key = process.argv[n].replace(/^--/, '');
    if (!allowed.has(key) || args[key] || !process.argv[n + 1] || process.argv[n + 1].startsWith('--')) throw Error('Usage: node render.mjs --config profile.json --data public-data.json [--projects projects.json] [--avatar avatar.png] [--icons icons.json] --out EMPTY_DIRECTORY');
    args[key] = process.argv[n + 1];
  }
  for (const key of ['config', 'data', 'out']) if (!args[key]) throw Error(`Missing --${key}`);
  const out = resolve(args.out);
  if (existsSync(out) && (lstatSync(out).isSymbolicLink() || !lstatSync(out).isDirectory() || readdirSync(out).length)) throw Error('Output must be a new or empty directory; existing files are never overwritten.');
  const c = json(args.config);
  const snapshot = json(args.data);
  const styles = args.projects ? json(args.projects) : { version: 1, projects: [] };
  const allIcons = args.icons ? json(args.icons) : json(join(root, 'dist/icons.json'));
  const d = validateInputs(c, snapshot, styles, allIcons);
  const iconNames = [...upstream.usedIcons(c, d), ...styles.projects.map(s => s.icon).filter(Boolean), 'person', 'code'];
  const missingIcons = iconNames.filter(name => name.startsWith('brand:') ? !allIcons.brand[name.slice(6)] : !allIcons.symbol[name]);
  if (missingIcons.length) throw Error(`Unknown icons: ${[...new Set(missingIcons)].join(', ')}`);
  const icons = upstream.pickIcons(allIcons, iconNames);
  // There is intentionally no network or environment-token code in this entrypoint.
  globalThis.fetch = () => { throw Error('Network is disabled in the offline renderer'); };
  let avatar = null;
  if (args.avatar) {
    const bytes = readFileSync(resolve(args.avatar));
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' :
      bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' :
      bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
    if (!mime || bytes.length > 2_000_000) throw Error('Avatar must be a local PNG/JPEG/WebP <= 2 MB. SVG/URLs are not accepted.');
    avatar = `data:${mime};base64,${bytes.toString('base64')}`;
  }
  c.hidden = [...new Set([...c.hidden, 'streak'])];
  const files = upstream.render(c, d, icons, avatar);
  const palettes = { profile: {}, projects: {} };
  const filled = c.iconFill === false ? icons : upstream.withFill(icons);
  for (const theme of ['light', 'dark']) {
    const p = upstream.palette(c.seed, c.scheme, theme === 'dark');
    palettes.profile[theme] = p;
    files[`assets/header-${theme}.svg`] = files[`assets/hero-${theme}.svg`];
    files[`assets/hero-mobile-${theme}.svg`] = mobileHero(c, p, filled, avatar);
    files[`assets/stack-mobile-${theme}.svg`] = mobileStack(c, p, filled);
    // Native stats mix public counters with contributions/calendar. Replace that block completely.
    files[`assets/stats-${theme}.svg`] = publicStats(c, d, p, filled);
    delete files[`assets/streak-${theme}.svg`];
    d.all.forEach((repo, index) => {
      const s = styles.projects.find(s => s.name === repo.name) || { name: repo.name, seed: c.seed };
      const pc = structuredClone(c);
      pc.seed = s.seed;
      pc.scheme = s.scheme || c.scheme;
      pc.projects.overrides[repo.name] = { ...pc.projects.overrides[repo.name],
        ...(s.subtitle !== undefined ? { text: s.subtitle } : {}), ...(s.icon ? { icon: s.icon } : {}), ...(s.shape ? { shape: s.shape } : {}) };
      const pp = upstream.palette(pc.seed, pc.scheme, theme === 'dark');
      const ctx = { c: pc, d, p: pp, i: filled };
      const slug = upstream.slug(repo.name);
      const displayRepo = s.title ? { ...repo, name: s.title } : repo;
      // Keep the real repo key for native overrides when a display title is used.
      if (s.title) pc.projects.overrides[s.title] = pc.projects.overrides[repo.name];
      files[`assets/project-${slug}-${theme}.svg`] = upstream.card(ctx, displayRepo, index);
      pc.hero = { greeting: `${c.login} /`, name: s.title || repo.name, subtitle: s.subtitle ?? repo.text,
        typing: false, avatarShape: s.shape || c.hero.avatarShape,
        chips: repo.language ? [{ icon: s.icon || 'code', label: repo.language }] : [] };
      files[`banners/${slug}-${theme}.svg`] = upstream.hero(ctx, null);
      palettes.projects[repo.name] ??= { seed: pc.seed, scheme: pc.scheme };
      palettes.projects[repo.name][theme] = pp;
    });
  }
  files['README.md'] = upstream.readme(c, d, files).replaceAll('width="49%"', 'width="412"');
  for (const block of ['hero', 'stack']) {
    files['README.md'] = files['README.md'].replace(
      `<picture><source media="(prefers-color-scheme: dark)" srcset="assets/${block}-dark.svg">`,
      `<picture><source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="assets/${block}-mobile-dark.svg">` +
      `<source media="(max-width: 600px)" srcset="assets/${block}-mobile-light.svg">` +
      `<source media="(prefers-color-scheme: dark)" srcset="assets/${block}-dark.svg">`);
  }
  for (const repo of d.all) {
    const slug = upstream.slug(repo.name);
    files[`snippets/${slug}.md`] = `<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">\n  <img src="assets/banner-light.svg" alt="${upstreamEscape(repo.name)}" width="100%">\n</picture>\n`;
  }
  files['profile.json'] = JSON.stringify(c, null, 2) + '\n';
  files['palettes.json'] = JSON.stringify(palettes, null, 2) + '\n';
  files['.profile/public-data.json'] = JSON.stringify({ version: 1, login: c.login, capturedAt: snapshot.capturedAt,
    publicOnly: true, statsPublicOnly: true, ...(snapshot.example === true ? { example: true } : {}),
    data: { followers: d.followers, languages: d.languages,
      pins: d.pins.map(r => ({ ...r, visibility: 'PUBLIC' })), all: d.all.map(r => ({ ...r, visibility: 'PUBLIC' })) } }, null, 2) + '\n';
  files['manifest.json'] = JSON.stringify({ version: 1, upstream: `https://github.com/metawka/expressive-profile/tree/${UPSTREAM_COMMIT}`,
    privacy: 'public REST snapshot only; no contributions/calendar/streak', example: snapshot.example === true,
    projects: d.all.map(r => ({ name: r.name, slug: upstream.slug(r.name), seed: styles.projects.find(s => s.name === r.name)?.seed || c.seed })),
    files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, digest(body)])) }, null, 2) + '\n';
  for (const [name, body] of Object.entries(files)) {
    const path = join(out, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  cpSync(join(root, 'licenses'), join(out, 'licenses'), { recursive: true });
  console.log(JSON.stringify({ output: out, projects: d.all.length, themes: ['light', 'dark'], example: snapshot.example === true, calendar: false, streak: false }));
}

function upstreamEscape(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function mobileBadges(items, x, y, width, p, icons, tonal = false, centered = false) {
  const { fit, textWidth, txt, icon } = upstream;
  const rows = [[]];
  let used = 0;
  for (const item of items) {
    const label = fit(item.label, 16, width - 52, 500);
    const w = 52 + textWidth(label, 16, 500);
    if (used && used + 8 + w > width) { rows.push([]); used = 0; }
    rows.at(-1).push({ item, label, w });
    used += (used ? 8 : 0) + w;
  }
  const body = [];
  for (const row of rows.filter(row => row.length)) {
    const rowWidth = row.reduce((sum, item) => sum + item.w, 0) + (row.length - 1) * 8;
    let left = x + (centered ? (width - rowWidth) / 2 : 0);
    for (const { item, label, w } of row) {
      body.push(`<rect x="${left.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="36" rx="10" fill="${tonal ? p.secondaryContainer : p.surfaceContainerLow}"/>`,
        icon(icons, item.icon, left + 12, y + 8, 20, tonal ? p.onSecondaryContainer : p.primary),
        txt(left + 40, y + 24, label, 16, tonal ? p.onSecondaryContainer : p.onSurface, { weight: 500 }));
      left += w + 8;
    }
    y += 44;
  }
  return { body: body.join(''), end: items.length ? y - 8 : y };
}

function mobileHero(c, p, icons, avatar) {
  const { svg, shape, icon, txt, wrap } = upstream;
  const name = c.hero.name || c.login;
  const names = wrap(name, 32, 364, 700, 2);
  const greeting = wrap(c.hero.greeting, 18, 364, 500, 2);
  const body = [];
  const cx = 210, cy = 80;
  body.push(`<path class="spin" d="${shape('sunny', cx, cy, 57)}" fill="${p.primary}"/>`,
    `<clipPath id="mobile-avatar"><path d="${shape(c.hero.avatarShape, cx, cy, 48)}"/></clipPath>`,
    `<path d="${shape(c.hero.avatarShape, cx, cy, 51)}" fill="${p.surfaceContainer}"/>`);
  if (avatar) body.push(`<image href="${avatar}" x="162" y="32" width="96" height="96" clip-path="url(#mobile-avatar)" preserveAspectRatio="xMidYMid slice"/>`);
  else body.push(`<path d="${shape(c.hero.avatarShape, cx, cy, 48)}" fill="${p.primaryContainer}"/>`, icon(icons, 'person', 186, 56, 48, p.onPrimaryContainer));
  let y = 164;
  greeting.forEach(line => { body.push(txt(210, y, line, 18, p.onSurfaceVariant, { weight: 500, anchor: 'middle' })); y += 24; });
  y += 12;
  names.forEach(line => { body.push(txt(210, y, line, 32, p.onSurface, { weight: 700, anchor: 'middle' })); y += 38; });
  y += 2;
  if (c.hero.subtitle.trim()) wrap(c.hero.subtitle, 18, 364, 400, 4).forEach(line => {
    body.push(txt(210, y, line, 18, p.onSurfaceVariant, { anchor: 'middle' })); y += 25;
  });
  const badges = mobileBadges(c.hero.chips, 28, y + 2, 364, p, icons, true, true);
  const h = badges.end + 28;
  const background = `<clipPath id="mobile-hero-card"><rect width="420" height="${h}" rx="32"/></clipPath>` +
    `<rect width="420" height="${h}" rx="32" fill="${p.surfaceContainer}"/>` +
    `<g clip-path="url(#mobile-hero-card)"><path class="spin" d="${shape('flower', 410, 16, 105)}" fill="${p.primaryContainer}"/>` +
    `<path class="bob" d="${shape('clover', 10, h - 12, 58)}" fill="${p.tertiaryContainer}"/></g>`;
  return svg(420, h, background + body.join('') + badges.body, `${c.hero.greeting} ${name}`, c.motion);
}

function mobileStack(c, p, icons) {
  const { svg, shape, icon, txt, wrap } = upstream;
  const body = [`<path d="${shape('cookie', 46, 46, 20)}" fill="${p.primaryContainer}"/>`, icon(icons, 'code', 35, 35, 22, p.onPrimaryContainer)];
  let y = 54;
  wrap(c.stack.title, 24, 312, 600, 2).forEach(line => { body.push(txt(80, y, line, 24, p.onSurface, { weight: 600 })); y += 30; });
  y += 8;
  for (const group of c.stack.groups) {
    const top = y;
    const lines = group.title ? wrap(group.title, 16, 340, 600, 3) : [];
    const text = [];
    y += 28;
    lines.forEach(line => { text.push(txt(40, y, line, 16, p.onSurfaceVariant, { weight: 600 })); y += 22; });
    const badges = mobileBadges(group.items, 40, y + (lines.length ? 2 : -12), 340, p, icons);
    y = badges.end + 16;
    body.push(`<rect x="24" y="${top}" width="372" height="${y - top}" rx="24" fill="${p.surfaceContainerHigh}"/>`, ...text, badges.body);
    y += 12;
  }
  const h = y + 12;
  return svg(420, h, `<rect width="420" height="${h}" rx="32" fill="${p.surfaceContainerLow}"/>` + body.join(''), c.stack.title, c.motion);
}

function publicStats(c, d, p, icons) {
  const { svg, txt, fit, shape, icon } = upstream;
  const rows = d.languages.length && c.stats.showLanguages ? d.languages.map(([name, bytes]) => `${name}: ${bytes.toLocaleString('en-US')} B`) : [];
  const h = 218 + rows.length * 24;
  const body = [`<rect width="840" height="${h}" rx="32" fill="${p.surfaceContainerLow}"/>`, txt(28, 52, fit(c.stats.title, 24, 784, 600), 24, p.onSurface, { weight: 600 })];
  [['star', d.stars, c.stats.stars], ['book_2', d.repos, c.stats.repos], ['group', d.followers, c.stats.followers]].forEach(([ic, value, label], n) => {
    const x = 28 + n * 264;
    body.push(`<rect x="${x}" y="78" width="256" height="104" rx="24" fill="${p.surfaceContainerHigh}"/>`,
      `<path d="${shape(['cookie', 'sunny', 'flower'][n], x + 34, 112, 20)}" fill="${p.primaryContainer}"/>`,
      icon(icons, ic, x + 24, 102, 20, p.onPrimaryContainer), txt(x + 66, 126, fit(String(value), 30, 164, 700), 30, p.onSurface, { weight: 700 }),
      txt(x + 20, 162, fit(label, 14, 216, 500), 14, p.onSurfaceVariant, { weight: 500 }));
  });
  rows.forEach((line, n) => body.push(txt(28, 216 + n * 24, fit(line, 14, 784), 14, p.onSurfaceVariant)));
  return svg(840, h, body.join(''), c.stats.title, c.motion);
}

try { main(); } catch (error) { console.error(`Render failed: ${error.message}`); process.exitCode = 1; }
