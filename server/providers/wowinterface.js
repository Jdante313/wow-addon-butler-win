'use strict';

const { fetchJson } = require('../lib/http');
const { AppError } = require('../lib/errors');
const { cleanText, normalizeDate, stripHtml } = require('../lib/utils');
const { knownLanguage } = require('../lib/language');

const API = 'https://api.mmoui.com/v3/game/WOW';
const CACHE_TTL = 30 * 60 * 1000;
let cache = null;

async function fileList() {
  if (cache && cache.expires > Date.now()) return cache.value;
  const data = await fetchJson(`${API}/filelist.json`, { timeout: 45000, retries: 1 });
  const list = Array.isArray(data) ? data : data?.data;
  if (!Array.isArray(list)) throw new AppError('WoWInterface 接口返回异常', 'WOWI_API', 502);
  cache = { value: list, expires: Date.now() + CACHE_TTL };
  return list;
}

function pick(item, keys, fallback = '') {
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== '') return item[key];
  }
  return fallback;
}

function map(item) {
  const id = pick(item, ['UID', 'UIID', 'id']);
  const thumbs = pick(item, ['UIIMG_Thumbs', 'UIIMGThumbs'], []);
  const screenshots = Array.isArray(thumbs)
    ? thumbs.map((thumb) => (typeof thumb === 'string' ? thumb : thumb?.URL || thumb?.url)).filter(Boolean)
    : [];
  return {
    key: `wowinterface:${id}`,
    source: 'wowinterface',
    sourceLabel: 'WoWInterface',
    id: String(id),
    name: cleanText(pick(item, ['UIName', 'name'], '未命名插件')),
    summary: stripHtml(pick(item, ['UIDescription', 'UISummary', 'description'], '')).slice(0, 700),
    description: stripHtml(pick(item, ['UIDescription', 'UISummary', 'description'], '')),
    author: cleanText(pick(item, ['UIAuthorName', 'author'], 'WoWInterface')),
    icon: pick(item, ['UIIMG_Thumb', 'UIIMGThumb', 'UIImage'], '') || screenshots[0] || '',
    screenshots: screenshots.slice(0, 8),
    version: cleanText(pick(item, ['UIVersion', 'version'], '')),
    updatedAt: normalizeDate(pick(item, ['UIDate', 'UIFileDate', 'date'], '')),
    downloads: Number(pick(item, ['UIDownloadTotal', 'UIDownload', 'downloads'], 0)) || 0,
    favorites: 0,
    categories: [cleanText(pick(item, ['UICategory', 'category'], ''))].filter(Boolean),
    compatible: [],
    language: knownLanguage(pick(item, ['UIName', 'name']), pick(item, ['UIDescription', 'UISummary'])) || '',
    size: Number(pick(item, ['UIFileSize', 'size'], 0)) || 0,
    officialUrl: pick(item, ['UIFileInfoURL', 'UILink', 'url'], ''),
    url: pick(item, ['UIFileInfoURL', 'UILink', 'url'], `https://www.wowinterface.com/downloads/info${id}`),
    downloadUrl: `https://cdn.wowinterface.com/downloads/getfile.php?id=${id}`,
    directory: cleanText(pick(item, ['UIFilename', 'filename'], '')).replace(/\.zip$/i, ''),
  };
}

async function search(options = {}) {
  const query = cleanText(options.query || '').toLowerCase();
  const items = (await fileList()).map(map);
  const filtered = query
    ? items.filter((item) =>
        `${item.name} ${item.summary} ${item.author}`.toLowerCase().includes(query),
      )
    : items;
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = 20;
  return {
    source: 'wowinterface',
    sourceLabel: 'WoWInterface',
    total: filtered.length,
    page,
    pageSize,
    hasMore: page * pageSize < filtered.length,
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
  };
}

async function detail(id) {
  const data = await fetchJson(`${API}/filedetails/${encodeURIComponent(id)}.json`, {
    timeout: 30000,
    retries: 1,
  });
  const item = Array.isArray(data) ? data[0] : data?.data?.[0] || data;
  if (!item) throw new AppError('没有找到这个 WoWInterface 插件', 'NOT_FOUND', 404);
  const mapped = map(item);
  mapped.versions = [{ version: mapped.version, date: mapped.updatedAt, size: mapped.size, label: '', compatible: [], notes: '' }];
  return mapped;
}

async function latest(id) {
  const data = await fetchJson(`${API}/filedetails/${encodeURIComponent(id)}.json`, {
    timeout: 30000,
    retries: 1,
  });
  const item = Array.isArray(data) ? data[0] : data?.data?.[0] || data;
  if (!item) throw new AppError('没有找到这个 WoWInterface 插件', 'NOT_FOUND', 404);
  const mapped = map(item);
  return {
    version: mapped.version,
    date: mapped.updatedAt,
    size: mapped.size,
    label: '',
    compatible: [],
    isBeta: false,
  };
}

async function download(id) {
  return {
    url: `https://cdn.wowinterface.com/downloads/getfile.php?id=${encodeURIComponent(id)}`,
    name: `wowinterface-${id}.zip`,
    size: 0,
  };
}

async function test() {
  const started = Date.now();
  const list = await fileList();
  return { ok: true, latency: Date.now() - started, message: `WoWInterface 连接正常，共 ${list.length} 个文件` };
}

module.exports = {
  id: 'wowinterface',
  label: 'WoWInterface',
  description: '欧美老牌官方插件站，实验性支持',
  experimental: true,
  search,
  detail,
  latest,
  download,
  test,
};
