import { slug } from './dist/upstream.mjs';
import { schemas, checkSchema } from './schema.mjs';
const fail = message => { throw Error(message); };
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const schemes = ['tonalSpot', 'vibrant', 'expressive', 'fidelity', 'monochrome'];
const shapes = ['cookie', 'cookie12', 'clover', 'sunny', 'flower', 'pill', 'soft', 'gem'];
const blocks = ['hero', 'about', 'stack', 'projects', 'stats', 'streak', 'socials', 'wave', 'buttons'];
const str = (value, at, max = 2000) => { if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) fail(`Invalid string: ${at}`); };
const count = (value, at) => { if (!Number.isSafeInteger(value) || value < 0) fail(`Invalid public count: ${at}`); };
const one = (value, list, at) => { if (!list.includes(value)) fail(`Invalid ${at}`); };
const color = value => { if (!/^#[\da-f]{6}$/i.test(value)) fail('Seed must be #RRGGBB'); };
function link(value, at) {
  str(value, at);
  if (!value) return;
  let u; try { u = new URL(value); } catch { fail(`Invalid URL: ${at}`); }
  if (!['https:', 'mailto:'].includes(u.protocol) || u.username || u.password) fail(`Unsafe URL: ${at}`);
}
export function validateInputs(c, s, styles, icons) {
  checkSchema(c, schemas.profile, 'config');
  checkSchema(s, schemas['public-data'], 'snapshot');
  checkSchema(styles, schemas.projects, 'styles');
  if (c.version !== 1 || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(c.login)) fail('Invalid config version/login');
  if (c.seedFromAvatar !== false) fail('Set seedFromAvatar:false; explicit offline MD3 seed required');
  color(c.seed); one(c.scheme, schemes, 'scheme'); one(c.hero.avatarShape, shapes, 'avatarShape');
  for (const field of ['order', 'hidden']) { c[field].forEach(b => one(b, blocks, field)); if (new Set(c[field]).size !== c[field].length) fail(`Duplicate ${field}`); }
  one(c.projects.source, ['pinned', 'manual'], 'projects.source');
  one(c.socials.variant, ['icon', 'chip'], 'socials.variant'); one(c.socials.fill, ['tonal', 'filled', 'outlined', 'brand'], 'socials.fill');
  if (c.socials.shape) one(c.socials.shape, shapes, 'socials.shape');
  const item = x => { if (!obj(x)) fail('Invalid item'); str(x.icon, 'item.icon', 100); str(x.label, 'item.label', 300); };
  c.hero.chips.forEach(item); c.about.items.forEach(item);
  c.stack.groups.forEach(g => { str(g.title, 'group.title'); if (!Array.isArray(g.items)) fail('Invalid group.items'); g.items.forEach(item); });
  c.buttons.items.forEach(b => { item(b); link(b.url, 'button.url'); one(b.style, ['filled', 'tonal'], 'button.style'); });
  c.socials.items.forEach(b => { str(b.icon, 'social.icon', 100); link(b.url, 'social.url'); });
  if (!obj(c.projects.overrides)) fail('Invalid projects.overrides');
  for (const v of Object.values(c.projects.overrides)) { if (!obj(v)) fail('Invalid override'); if (v.text !== undefined) str(v.text, 'override.text'); if (v.icon !== undefined) str(v.icon, 'override.icon'); if (v.shape) one(v.shape, shapes, 'override.shape'); }
  if (!obj(s) || s.version !== 1 || s.login !== c.login || s.publicOnly !== true || s.statsPublicOnly !== true || !Number.isFinite(Date.parse(s.capturedAt))) fail('Snapshot requires version:1, matching login, capturedAt, publicOnly:true and statsPublicOnly:true');
  const d = s.data;
  if (!obj(d) || !Array.isArray(d.all) || !Array.isArray(d.pins) || !Array.isArray(d.languages)) fail('Invalid snapshot data');
  const seen = new Set(); const slugs = new Set();
  for (const r of d.all) {
    if (!obj(r) || r.visibility !== 'PUBLIC') fail('Only visibility:PUBLIC repositories accepted');
    if (!/^[a-z\d_.-]{1,100}$/i.test(r.name) || /^\.+$/.test(r.name)) fail('Unsafe repository name');
    const key = r.name.toLowerCase(); const file = slug(r.name);
    if (seen.has(key) || slugs.has(file)) fail('Duplicate repository or colliding slug'); seen.add(key); slugs.add(file);
    if (r.url !== `https://github.com/${c.login}/${r.name}`) fail('Repository URL must match public owner/name');
    str(r.text, 'repo.text'); count(r.stars, 'repo.stars');
    if (typeof r.fork !== 'boolean' || (r.language !== null && typeof r.language !== 'string') || !Array.isArray(r.topics)) fail('Invalid repository metadata');
    if (r.language !== null) str(r.language, 'repo.language', 100); r.topics.forEach(t => str(t, 'repo.topic', 100));
  }
  const byName = new Map(d.all.map(r => [r.name, r]));
  const selected = [...c.projects.repos, ...d.pins.map(r => r.name), ...Object.keys(c.projects.overrides)];
  if (selected.some(name => !byName.has(name))) fail('Unknown project/pin/override; every repository must be present in public all');
  for (const r of d.pins) if (r.visibility !== 'PUBLIC' || r.url !== byName.get(r.name)?.url) fail('Pin must reference the same public repository');
  count(d.followers, 'followers');
  for (const pair of d.languages) { if (!Array.isArray(pair) || pair.length !== 2) fail('Invalid language tuple'); str(pair[0], 'language', 100); count(pair[1], 'language bytes'); }
  if (!obj(styles) || styles.version !== 1 || !Array.isArray(styles.projects)) fail('Invalid projects styles version/array');
  const styleNames = new Set();
  for (const p of styles.projects) {
    if (!byName.has(p.name) || styleNames.has(p.name)) fail('Unknown or duplicate project style'); styleNames.add(p.name); color(p.seed);
    if (p.scheme) one(p.scheme, schemes, 'project.scheme'); if (p.shape) one(p.shape, shapes, 'project.shape');
    for (const field of ['title', 'subtitle', 'icon']) if (p[field] !== undefined) str(p[field], `project.${field}`, field === 'icon' ? 100 : 2000);
  }
  if (!obj(icons) || !obj(icons.symbol) || !obj(icons.brand)) fail('Invalid icons');
  const path = d => { if (typeof d !== 'string' || !/^[MmZzLlHhVvCcSsQqTtAa\d\s.,+eE-]*$/.test(d)) fail('Unsafe icon path'); };
  Object.values(icons.symbol).forEach(path);
  Object.values(icons.brand).forEach(b => { path(b.d); str(b.t, 'brand.title'); if (b.c && !/^[a-f\d]{6}$/i.test(b.c)) fail('Invalid brand hex'); });
  return { stars: d.all.reduce((n, r) => n + r.stars, 0), repos: d.all.length, followers: d.followers,
    languages: d.languages, contributions: 0, days: [], streak: { current: 0, longest: 0 },
    pins: d.pins.map(r => byName.get(r.name)), all: d.all.map(({ name, url, text, fork, stars, language, topics }) => ({ name, url, text, fork, stars, language, topics })) };
}
