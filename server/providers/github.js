'use strict';

const { fetchJson } = require('../lib/http');
const { AppError } = require('../lib/errors');
const { cleanText, normalizeDate, stripHtml } = require('../lib/utils');
const { knownLanguage } = require('../lib/language');

const API = 'https://api.github.com';
const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map();

function headers() {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'WowAddonButler/1.0',
  };
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit || hit.expires < Date.now()) return null;
  return hit.value;
}

function cacheSet(key, value, ttl = CACHE_TTL) {
  if (cache.size > 100) cache.clear();
  cache.set(key, { value, expires: Date.now() + ttl });
  return value;
}

function mapRepo(repo) {
  const [owner, name] = String(repo.full_name || '').split('/');
  return {
    key: `github:${repo.full_name}`,
    source: 'github',
    sourceLabel: 'GitHub',
    id: repo.full_name,
    name: cleanText(repo.name || name),
    summary: stripHtml(repo.description || '').slice(0, 700),
    description: stripHtml(repo.description || ''),
    author: owner || '',
    icon: repo.owner?.avatar_url || '',
    screenshots: [],
    version: '',
    updatedAt: normalizeDate(repo.pushed_at || repo.updated_at),
    downloads: 0,
    favorites: Number(repo.stargazers_count || 0),
    categories: ['开源仓库'],
    compatible: [],
    language: knownLanguage(repo.name, repo.description) || '',
    size: 0,
    officialUrl: repo.html_url || '',
    url: repo.html_url || '',
    repo: repo.full_name,
    defaultBranch: repo.default_branch || 'main',
  };
}

async function search(options = {}) {
  const query = cleanText(options.query || '');
  const page = Math.max(1, Number(options.page) || 1);
  const q = query
    ? `${query} wow addon in:name,description,readme`
    : 'topic:wow-addon';
  const key = `search:${q}:${page}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const data = await fetchJson(
    `${API}/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=15&page=${page}`,
    { headers: headers(), timeout: 25000, retries: 1 },
  );
  const items = (data.items || [])
    .filter((repo) => !repo.archived)
    .filter((repo) =>
      /wow|warcraft|addon|weakaura|elvui/i.test(
        `${repo.name} ${repo.description || ''} ${(repo.topics || []).join(' ')}`,
      ),
    )
    .map(mapRepo);
  const result = {
    source: 'github',
    sourceLabel: 'GitHub',
    total: Number(data.total_count || items.length),
    page,
    pageSize: 15,
    hasMore: items.length >= 15,
    items,
  };
  cacheSet(key, result, 2 * 60 * 1000);
  return result;
}

async function release(repo) {
  try {
    return await fetchJson(`${API}/repos/${repo}/releases/latest`, {
      headers: headers(),
      timeout: 25000,
      retries: 1,
    });
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function pickAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return (
    assets.find((asset) => /\.zip$/i.test(asset.name) && !/source|code/i.test(asset.name)) ||
    assets.find((asset) => /\.zip$/i.test(asset.name)) ||
    null
  );
}

async function detail(id) {
  const repo = String(id || '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new AppError('无效的 GitHub 仓库', 'BAD_ID', 400);
  const data = await fetchJson(`${API}/repos/${repo}`, {
    headers: headers(),
    timeout: 25000,
    retries: 1,
  });
  const mapped = mapRepo(data);
  const rel = await release(repo);
  const asset = pickAsset(rel);
  mapped.version = cleanText(rel?.tag_name || '');
  mapped.fileName = asset?.name || '';
  mapped.releaseNotes = stripHtml(rel?.body || '').slice(0, 4000);
  mapped.versions = rel
    ? [
        {
          version: mapped.version,
          date: normalizeDate(rel.published_at),
          size: Number(asset?.size || 0),
          label: rel.prerelease ? '测试版' : '',
          compatible: [],
          notes: mapped.releaseNotes,
        },
      ]
    : [];
  mapped.url = data.html_url;
  return mapped;
}

async function latest(id) {
  const repo = String(id || '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new AppError('无效的 GitHub 仓库', 'BAD_ID', 400);
  const rel = await release(repo);
  if (!rel) throw new AppError('该仓库没有发布版本', 'NO_RELEASE', 404);
  return {
    version: cleanText(rel.tag_name || ''),
    date: normalizeDate(rel.published_at),
    size: Number(pickAsset(rel)?.size || 0),
    label: rel.prerelease ? '测试版' : '',
    compatible: [],
    isBeta: Boolean(rel.prerelease),
    assetName: pickAsset(rel)?.name || '',
  };
}

async function download(id) {
  const repo = String(id || '');
  const rel = await release(repo);
  if (!rel) throw new AppError('该仓库没有发布版本', 'NO_RELEASE', 404);
  const asset = pickAsset(rel);
  if (asset?.browser_download_url) {
    return {
      url: asset.browser_download_url,
      name: asset.name,
      size: Number(asset.size || 0),
    };
  }
  const data = await fetchJson(`${API}/repos/${repo}`, {
    headers: headers(),
    timeout: 25000,
    retries: 1,
  });
  return {
    url: `https://github.com/${repo}/archive/refs/heads/${data.default_branch || 'main'}.zip`,
    name: `${repo.replace('/', '-')}.zip`,
    size: 0,
  };
}

async function test() {
  const started = Date.now();
  await fetchJson(`${API}/rate_limit`, { headers: headers(), timeout: 20000, retries: 1 });
  return { ok: true, latency: Date.now() - started, message: 'GitHub API 连接正常' };
}

module.exports = {
  id: 'github',
  label: 'GitHub',
  description: '作者一手开源发布仓库，适合进阶用户',
  experimental: true,
  search,
  detail,
  latest,
  download,
  test,
};
