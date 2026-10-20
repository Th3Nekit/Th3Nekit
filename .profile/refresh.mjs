import { readFile, writeFile, readdir, lstat, mkdir, mkdtemp, rename, rm, rmdir } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';

const exec = promisify(execFile);
const API = 'https://api.github.com';
const LOGIN = 'Th3Nekit';
const API_VERSION = '2026-03-10';
const SELF = fileURLToPath(import.meta.url);
const JSON_LIMIT = 10_000_000;
const AVATAR_LIMIT = 2_000_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const repoName = value => typeof value === 'string' && /^[a-z\d_.-]{1,100}$/i.test(value) && !/^\.+$/.test(value);
const fail = message => { throw new Error(message); };
const json = bytes => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
const encode = value => JSON.stringify(value, null, 2) + '\n';
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('Invalid public API count');
  return value;
}
function text(value, limit) {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) fail('Invalid public API text');
  return value;
}
function manualNames(config) {
  if (config?.login !== LOGIN || config?.projects?.source !== 'manual' || !Array.isArray(config.projects.repos)) fail('Expected Th3Nekit profile with manual public projects');
  const names = config.projects.repos;
  if (names.some(name => !repoName(name)) || new Set(names.map(name => name.toLowerCase())).size !== names.length) fail('Invalid manual public project list');
  return names;
}
function workflowToken(env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || '';
  if (token && (typeof token !== 'string' || !/^ghs_[a-z\d_]+$/i.test(token))) fail('Only a workflow installation token (ghs_) is accepted; omit the token for anonymous public REST');
  return token;
}
async function limitedBytes(response, limit, label) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    fail(`${label} exceeds size limit`);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail(`${label} exceeds size limit`); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
async function apiGet(path, fetchImpl, token) {
  const url = new URL(path, API);
  if (url.origin !== API || url.username || url.password || url.hash) fail('Only the fixed GitHub REST API origin is allowed');
  let response;
  try {
    response = await fetchImpl(url.href, {
      method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'Th3Nekit-public-profile-refresh', 'Cache-Control': 'no-cache',
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  } catch { fail('Public GitHub REST request failed'); }
  if (response.status !== 200) {
    await response.body?.cancel();
    fail(`Public GitHub REST API returned HTTP ${response.status}`);
  }
  let body;
  try { body = json(await limitedBytes(response, JSON_LIMIT, 'Public API response')); }
  catch { fail('Invalid or oversized public GitHub REST response'); }
  return { body, link: response.headers.get('link') };
}
function nextPage(link, path, current) {
  if (!link) return null;
  const next = link.split(',').map(part => /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part)).filter(match => match && match[2].split(' ').includes('next'));
  if (!next.length) return null;
  if (next.length !== 1) fail('Ambiguous repository pagination');
  let url;
  try { url = new URL(next[0][1]); } catch { fail('Invalid repository pagination'); }
  const page = Number(url.searchParams.get('page'));
  if (url.origin !== API || url.username || url.password || url.hash || url.pathname !== path || !Number.isSafeInteger(page) || page <= current || page > 1000) fail('Unsafe repository pagination');
  // Rebuild the next request ourselves; never follow a response-provided URL.
  return page;
}
function publicRepo(raw) {
  if (!object(raw) || raw.private !== false || raw.visibility !== 'public' || raw.owner?.login?.toLowerCase() !== LOGIN.toLowerCase()) return null;
  if (!repoName(raw.name) || raw.full_name?.toLowerCase() !== `${LOGIN}/${raw.name}`.toLowerCase() || typeof raw.fork !== 'boolean') fail('Invalid public owned repository metadata');
  if (!Array.isArray(raw.topics)) fail('Invalid public repository topics');
  return {
    name: raw.name, url: `https://github.com/${LOGIN}/${raw.name}`,
    text: raw.description === null ? '' : text(raw.description, 2000),
    fork: raw.fork, stars: count(raw.stargazers_count),
    language: raw.language === null ? null : text(raw.language, 100),
    topics: raw.topics.map(topic => text(topic, 100)), visibility: 'PUBLIC',
  };
}
function avatarURL(value) {
  let url;
  try { url = new URL(value); } catch { fail('Invalid public avatar URL'); }
  const host = url.hostname.toLowerCase();
  const contentHost = host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com');
  const githubAvatar = host === 'github.com' && url.pathname.toLowerCase() === `/${LOGIN.toLowerCase()}.png`;
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || (!contentHost && !githubAvatar)) fail('Unsafe public avatar URL');
  return url;
}
async function fetchAvatar(value, fetchImpl) {
  let url = avatarURL(value);
  for (let hop = 0; hop <= 5; hop++) {
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'image/png,image/jpeg,image/webp', 'User-Agent': 'Th3Nekit-public-profile-refresh' },
      });
    } catch { fail('Public avatar request failed'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hop === 5) fail('Invalid public avatar redirect');
      try { url = avatarURL(new URL(location, url).href); }
      catch { fail('Unsafe public avatar redirect'); }
      continue;
    }
    if (response.status !== 200) { await response.body?.cancel(); fail(`Public avatar returned HTTP ${response.status}`); }
    const bytes = await limitedBytes(response, AVATAR_LIMIT, 'Public avatar');
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!png && !jpeg && !webp) fail('Public avatar must be PNG, JPEG or WebP; SVG is not accepted');
    return bytes;
  }
  fail('Too many public avatar redirects');
}

export async function collectPublicData({ config, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const selected = manualNames(config);
  const token = workflowToken(env);
  const path = `/users/${LOGIN}/repos`;
  const repos = new Map();
  let page = 1;
  let requests = 0;
  while (page !== null) {
    if (++requests > 1000) fail('Repository pagination limit reached');
    const { body, link } = await apiGet(`${path}?type=owner&per_page=100&sort=full_name&direction=asc&page=${page}`, fetchImpl, token);
    if (!Array.isArray(body)) fail('Invalid public repository list');
    for (const raw of body) {
      const repo = publicRepo(raw);
      if (!repo) continue;
      const key = repo.name.toLowerCase();
      if (repos.has(key)) fail('Duplicate public repository across pages; retry a fresh snapshot');
      repos.set(key, repo);
    }
    page = nextPage(link, path, page) ?? (body.length === 100 ? page + 1 : null);
  }
  const all = [...repos.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en'));
  const byName = new Map(all.map(repo => [repo.name, repo]));
  if (!byName.has(LOGIN) || selected.some(name => !byName.has(name))) fail('Profile or manual project is absent from fresh public owned repositories');
  const { body: user } = await apiGet(`/users/${LOGIN}`, fetchImpl, token);
  if (!object(user) || user.login?.toLowerCase() !== LOGIN.toLowerCase()) fail('Invalid public user response');
  const followers = count(user.followers);
  const totals = new Map();
  for (const repo of all) {
    const { body: languages } = await apiGet(`/repos/${LOGIN}/${encodeURIComponent(repo.name)}/languages`, fetchImpl, token);
    if (!object(languages)) fail('Invalid public languages response');
    for (const [name, value] of Object.entries(languages)) {
      text(name, 100); count(value);
      if (!repo.fork && value > 0) totals.set(name, count((totals.get(name) || 0) + value));
    }
  }
  const avatar = await fetchAvatar(user.avatar_url, fetchImpl);
  const languages = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'));
  const stars = all.reduce((sum, repo) => count(sum + repo.stars), 0);
  return {
    snapshot: { version: 1, login: LOGIN, capturedAt: new Date().toISOString(), publicOnly: true, statsPublicOnly: true,
      data: { stars, contributions: 0, repos: all.length, followers, languages, days: [], streak: { current: 0, longest: 0 },
        pins: selected.map(name => byName.get(name)), all } },
    avatar,
  };
}

async function statOrNull(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function directory(path, optional = false) {
  const info = await statOrNull(path);
  if (optional && !info) return false;
  if (!info?.isDirectory() || info.isSymbolicLink()) fail('Expected a real directory; symbolic links are not allowed');
  return true;
}
async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail('Expected a regular file; symbolic links are not allowed');
  return readFile(path);
}
function childEnvironment(env) {
  const result = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (/^(path|systemroot|windir|temp|tmp|tmpdir|lang|lc_all)$/i.test(key) && typeof value === 'string') result[key] = value;
  }
  return result;
}
function checkRenderedSnapshot(value, source) {
  const expected = {
    version: 1, login: LOGIN, capturedAt: source.capturedAt, publicOnly: true, statsPublicOnly: true,
    data: { followers: source.data.followers, languages: source.data.languages, pins: source.data.pins, all: source.data.all },
  };
  if (!isDeepStrictEqual(value, expected)) fail('Renderer public snapshot does not match the fresh public-only data contract');
}
async function publicationFiles(out, snapshot) {
  await directory(out);
  await directory(join(out, 'assets'));
  await directory(join(out, '.profile'));
  const files = new Map([['README.md', await regularFile(join(out, 'README.md'))]]);
  const data = await regularFile(join(out, '.profile/public-data.json'));
  checkRenderedSnapshot(json(data), snapshot);
  files.set('.profile/public-data.json', data);
  const entries = await readdir(join(out, 'assets'), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!/^[a-z\d][a-z\d_.-]*\.svg$/i.test(entry.name) || !entry.name.endsWith('.svg')) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) fail('Renderer SVG output must be a regular file');
    const path = `assets/${entry.name}`;
    files.set(path, await regularFile(join(out, path)));
  }
  if (files.size < 3) fail('Renderer produced no SVG assets');
  return files;
}
async function publish(root, work, files) {
  const assetsExist = await directory(join(root, 'assets'), true);
  await directory(join(root, '.profile'));
  const pending = [];
  for (const [name, bytes] of files) {
    const destination = join(root, name);
    const info = await statOrNull(destination);
    if (info && (!info.isFile() || info.isSymbolicLink())) fail('Publication destination must be a regular file; symbolic links are not allowed');
    const previous = info ? await readFile(destination) : null;
    if (previous?.equals(bytes)) continue;
    const staged = join(work, `publish-${pending.length}`);
    const mode = info ? info.mode & 0o777 : 0o644;
    await writeFile(staged, bytes, { mode, flag: 'wx' });
    pending.push({ name, destination, staged, previous, mode });
  }
  const committed = [];
  try {
    if (!assetsExist) await mkdir(join(root, 'assets'));
    for (const entry of pending) {
      await rename(entry.staged, entry.destination);
      committed.push(entry);
    }
  } catch {
    let rollbackFailed = false;
    for (const entry of committed.reverse()) {
      try {
        if (entry.previous === null) await rm(entry.destination);
        else {
          await writeFile(entry.staged, entry.previous, { mode: entry.mode });
          await rename(entry.staged, entry.destination);
        }
      } catch { rollbackFailed = true; }
    }
    if (!assetsExist) {
      try { await rmdir(join(root, 'assets')); } catch { rollbackFailed = true; }
    }
    fail(rollbackFailed ? 'Publication failed; rollback was incomplete' : 'Publication failed; previous files were restored');
  }
  return pending.map(entry => entry.name);
}

export async function refreshProfile({ root = resolve(dirname(SELF), '..'), fetchImpl = globalThis.fetch, env = process.env } = {}) {
  root = resolve(root);
  await directory(root);
  await directory(join(root, '.profile'));
  await directory(join(root, '.profile/renderer'));
  await directory(join(root, 'assets'), true);
  const renderer = join(root, '.profile/renderer/render.mjs');
  await regularFile(renderer);
  const configBytes = await regularFile(join(root, 'profile.json'));
  const stylesBytes = await regularFile(join(root, 'project-styles.json'));
  const config = json(configBytes);
  manualNames(config);
  const { snapshot, avatar } = await collectPublicData({ config, fetchImpl, env });
  const work = await mkdtemp(join(root, '.profile-refresh-'));
  try {
    await writeFile(join(work, 'profile.json'), configBytes);
    await writeFile(join(work, 'project-styles.json'), stylesBytes);
    await writeFile(join(work, 'public-data.json'), encode(snapshot));
    await writeFile(join(work, 'avatar.png'), avatar);
    const out = join(work, 'output');
    try {
      await exec(process.execPath, [renderer,
        '--config', join(work, 'profile.json'), '--data', join(work, 'public-data.json'),
        '--projects', join(work, 'project-styles.json'), '--avatar', join(work, 'avatar.png'), '--out', out],
      { cwd: work, env: childEnvironment(env), timeout: 120_000, maxBuffer: 2_000_000, windowsHide: true });
    } catch { fail('Offline renderer failed; profile files were not changed'); }
    const files = await publicationFiles(out, snapshot);
    if (!(await regularFile(join(root, 'profile.json'))).equals(configBytes) || !(await regularFile(join(root, 'project-styles.json'))).equals(stylesBytes)) fail('Configuration changed during refresh; generated files were not published');
    const updated = await publish(root, work, files);
    return { publicRepositories: snapshot.data.all.length, manualProjects: config.projects.repos.length, updated };
  } finally { await rm(work, { recursive: true, force: true }); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node .profile/refresh.mjs [--root PROFILE_CHECKOUT]\nNode >=22. Optional GITHUB_TOKEN (or GH_TOKEN): workflow installation token only.');
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== '--root' || !args[1])) fail('Usage: node .profile/refresh.mjs [--root PROFILE_CHECKOUT]');
  const root = args[1] || resolve(dirname(SELF), basename(SELF) === 'refresh.mjs' ? '..' : '.');
  const result = await refreshProfile({ root });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main().catch(error => { console.error(`Profile refresh failed: ${error.message}`); process.exitCode = 1; });
}
