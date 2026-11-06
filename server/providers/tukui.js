'use strict';

const { fetchJson } = require('../lib/http');
const { AppError } = require('../lib/errors');
const { cleanText, normalizeDate, stripHtml } = require('../lib/utils');
const { knownLanguage } = require('../lib/language');

const API = 'https://api.tukui.org/v1/addons';
const CACHE_TTL = 10 * 60 * 1000;
let cache = null;

async function list() {
  if (cache && cache.expires > Date.now()) return cache.value;
  const raw = await fetchJson(API, { timeout: 25000, retries: 1 });
  if (!Array.isArray(raw)) throw new AppError('Tukui 接口返回异常', 'TUKUI_API', 502);
  cache = { value: raw, expires: Date.now() + CACHE_TTL };
  return raw;
}

function map(item) {
  const gallery = Array.isArray(item.gallery_url) ? item.gallery_url.filter(Boolean) : [];
  const desc = String(item.desc || '');
  return {
    key: `tukui:${item.slug}`,
    source: 'tukui',
    sourceLabel: 'Tukui',
    id: String(item.slug || item.id),
    name: cleanText(item.name),
    summary: stripHtml(item.small_desc || desc).slice(0, 700),
    description: stripHtml(desc),
    descriptionMarkdown: desc,
    author: cleanText(item.author || 'Tukui'),
    icon: item.logo_square_url || item.logo_url || '',
    screenshots: [item.screenshot_url, ...gallery].filter(Boolean).slice(0, 8),
    version: cleanText(item.version || ''),
    updatedAt: normalizeDate(item.last_update),
    downloads: 0,
    favorites: 0,
    categories: ['界面美化'],
    compatible: Array.isArray(item.patch) ? item.patch.map(String) : [],
    language: knownLanguage(item.name, item.desc) || '',
    size: 0,
    officialUrl: item.web_url || '',
    url: item.web_url || `https://tukui.org/${item.slug}`,
    downloadUrl: item.url,
    directories: Array.isArray(item.directories) ? item.directories : [],
    changelogUrl: item.changelog_url || '',
    gitUrl: item.git_url || '',
  };
}

async function search(options = {}) {
  const query = cleanText(options.query || '').toLowerCase();
  const items = (await list()).map(map);
  const filtered = query
    ? items.filter((item) =>
        `${item.name} ${item.summary} ${item.id}`.toLowerCase().includes(query),
      )
    : items;
  return {
    source: 'tukui',
    sourceLabel: 'Tukui',
    total: filtered.length,
    page: 1,
    pageSize: filtered.length,
    hasMore: false,
    items: filtered,
  };
}

async function detail(id) {
  const items = await list();
  const item = items.find((entry) => String(entry.slug) === String(id) || String(entry.id) === String(id));
  if (!item) throw new AppError('没有找到这个 Tukui 插件', 'NOT_FOUND', 404);
  const mapped = map(item);
  mapped.versions = item.changelog_url
    ? [{ version: mapped.version, date: mapped.updatedAt, size: 0, label: '', compatible: mapped.compatible, notes: '' }]
    : [];
  return mapped;
}

async function latest(id) {
  const items = await list();
  const item = items.find((entry) => String(entry.slug) === String(id) || String(entry.id) === String(id));
  if (!item) throw new AppError('没有找到这个 Tukui 插件', 'NOT_FOUND', 404);
  return {
    version: cleanText(item.version || ''),
    date: normalizeDate(item.last_update),
    size: 0,
    label: '',
    compatible: Array.isArray(item.patch) ? item.patch.map(String) : [],
    isBeta: false,
    directories: Array.isArray(item.directories) ? item.directories : [],
  };
}

async function download(id) {
  const items = await list();
  const item = items.find((entry) => String(entry.slug) === String(id) || String(entry.id) === String(id));
  if (!item?.url) throw new AppError('Tukui 没有提供下载地址', 'NO_DOWNLOAD', 404);
  const url = new URL(item.url);
  if (url.protocol !== 'https:') throw new AppError('下载地址不安全，已阻止', 'UNSAFE_URL', 400);
  return {
    url: url.toString(),
    name: `${item.slug}-${item.version || 'latest'}.zip`,
    size: 0,
  };
}

async function test() {
  const started = Date.now();
  const items = await list();
  return { ok: true, latency: Date.now() - started, message: `Tukui 连接正常，共 ${items.length} 个插件` };
}

module.exports = {
  id: 'tukui',
  label: 'Tukui',
  description: 'ElvUI / Tukui 官方发布源，直接下载',
  search,
  detail,
  latest,
  download,
  test,
};
