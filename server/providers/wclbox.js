'use strict';

const { fetchJson, fetchText } = require('../lib/http');
const { AppError } = require('../lib/errors');
const {
  cleanText,
  normalizeDate,
  safeString,
  stripHtml,
} = require('../lib/utils');
const { knownLanguage } = require('../lib/language');
const { wclboxCategoryId } = require('../categories');

const API_BASE = 'https://api.newbeebox.com';
const WEB_BASE = 'https://www.wclbox.com';
const DEFAULT_VERSION = 4;
const CACHE_TTL = 3 * 60 * 1000;

const memory = new Map();

function cacheGet(key) {
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    memory.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttl = CACHE_TTL) {
  if (memory.size > 300) memory.clear();
  memory.set(key, { value, expires: Date.now() + ttl });
  return value;
}

function apiHeaders(version) {
  return {
    'Content-Type': 'application/json',
    appId: '6',
    Origin: WEB_BASE,
    Referer: `${WEB_BASE}/games/1?version=${version}`,
  };
}

async function post(path, body, version = DEFAULT_VERSION) {
  const data = await fetchJson(`${API_BASE}${path}`, {
    method: 'POST',
    headers: apiHeaders(version),
    body: JSON.stringify(body),
    timeout: 25000,
    retries: 1,
  });
  if (!data || data.code !== 1) {
    throw new AppError(data?.message || data?.msg || '新手盒子接口暂时不可用', 'WCLBOX_API', 502);
  }
  return data.data;
}

function versionLabel(item) {
  const file = Array.isArray(item.file_list) ? item.file_list[0] : null;
  return cleanText(file?.file_display_name || '').replace(/\.zip$/i, '') || '';
}

function upstreamInfo(item) {
  const raw = cleanText(item.official || '');
  if (/^curse/i.test(raw)) {
    return { id: 'curseforge', label: 'CurseForge 官方', url: item.official_url || '' };
  }
  if (/^tukui/i.test(raw)) {
    return { id: 'tukui', label: 'Tukui 官方', url: item.official_url || '' };
  }
  if (raw) {
    return {
      id: 'newbeebox',
      label: raw,
      url: /^新手盒子$/i.test(raw) ? '' : item.official_url || '',
    };
  }
  return { id: '', label: '', url: item.official_url || '' };
}

function mapItem(item, version) {
  const id = safeString(item.id);
  const compat = Array.isArray(item.file_list?.[0]?.file_version)
    ? item.file_list[0].file_version.map(String)
    : [];
  const screenshots = Array.isArray(item.screenshot)
    ? item.screenshot.map((shot) => shot.url).filter(Boolean).slice(0, 8)
    : [];
  const upstream = upstreamInfo(item);
  return {
    key: `wclbox:${id}`,
    source: 'wclbox',
    sourceLabel: '新手盒子',
    id,
    name: cleanText(item.name) || '未命名插件',
    summary: stripHtml(item.description || '').slice(0, 700),
    description: stripHtml(item.description || ''),
    author: cleanText(
      item.user_info?.t_username ||
        (!/^(curse|tukui|新手盒子)$/i.test(cleanText(item.official || ''))
          ? item.official
          : '') ||
        '',
    ),
    icon: item.logo_url || screenshots[0] || '',
    screenshots,
    version: versionLabel(item),
    updatedAt: normalizeDate(item.update || item.file_list?.[0]?.file_date),
    downloads: Number(item.down_total || item.total_download_count || 0),
    favorites: Number(item.favorite_count || 0),
    categories: Array.isArray(item.categories)
      ? item.categories.map((cat) => cleanText(cat.name)).filter(Boolean)
      : [],
    compatible: compat,
    language: knownLanguage(item.name, item.description) || '',
    upstream: upstream.id,
    upstreamLabel: upstream.label,
    officialUrl: upstream.url,
    size: Number(item.main_file_length || item.file_list?.[0]?.file_length || 0),
    url: `${WEB_BASE}/games/1/PluginItem/${id}?version=${version}`,
    raw: {
      official: item.official || '',
      contenorigin: item.contenorigin,
      file: item.file_list?.[0] || null,
    },
  };
}

async function search(options = {}) {
  const query = safeString(options.query || '').trim().slice(0, 100);
  const version = Number(options.version) || DEFAULT_VERSION;
  const categoryKey = String(options.categoryKey || 'all');
  const category = Number(options.category) || wclboxCategoryId(categoryKey);
  const page = Math.max(1, Math.min(1000, Number(options.page) || 1));
  const sortMap = { popular: 'download', hot: 'download', updated: 'update', name: 'ranking' };
  const sort = ['ranking', 'download', 'favourite', 'update'].includes(options.sort)
    ? options.sort
    : sortMap[options.sort] || 'ranking';
  const key = `search:${version}:${query}:${category}:${page}:${sort}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const data = await post(
    '/web/mod/list',
    {
      versions: version,
      category,
      order: sort,
      offset: (page - 1) * 12,
      filter: query || '',
    },
    version,
  );
  const list = Array.isArray(data.list) ? data.list : [];
  const result = {
    source: 'wclbox',
    sourceLabel: '新手盒子',
    total: Number(data.total || data.count || list.length),
    page,
    pageSize: 12,
    hasMore: page * 12 < Number(data.total || 0),
    items: list.map((item) => mapItem(item, version)),
    categoryApplied: categoryKey !== 'all',
  };
  cacheSet(key, result, 2 * 60 * 1000);
  return result;
}

function extractMeta(html, property) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`,
    'i',
  );
  const reverse = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`,
    'i',
  );
  return html.match(re)?.[1] || html.match(reverse)?.[1] || '';
}

function extractAside(html) {
  const fields = {};
  const re = /<div><dt>([^<]+)<\/dt><dd[^>]*>([\s\S]*?)<\/dd><\/div>/g;
  let match;
  while ((match = re.exec(html))) {
    const label = cleanText(match[1]);
    const value = cleanText(match[2].replace(/<[^>]+>/g, ' '));
    if (label) fields[label] = value;
  }
  return fields;
}

async function detail(id, options = {}) {
  const version = Number(options.version) || DEFAULT_VERSION;
  const numericId = String(id || '').replace(/\D/g, '');
  if (!numericId) throw new AppError('无效的插件 ID', 'BAD_ID', 400);
  const key = `detail:${version}:${numericId}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const html = await fetchText(
    `${WEB_BASE}/games/1/PluginItem/${numericId}?version=${version}`,
    {
      headers: {
        Referer: `${WEB_BASE}/games/1?version=${version}`,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      timeout: 30000,
      retries: 1,
    },
  );

  const title =
    cleanText(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '') ||
    cleanText(extractMeta(html, 'og:title').replace(/\s*·\s*魔兽世界.*$/, ''));
  const descriptionHtml = extractMeta(html, 'og:description');
  const currentVersion =
    html.match(/data-current=["']([^"']+)["']/i)?.[1] ||
    html.match(/data-selected-version[^>]*>([^<]+)</i)?.[1] ||
    '';
  const downloadPath = html.match(/data-download=["']([^"']+)["']/i)?.[1] || '';
  const aside = extractAside(html);
  const screenshots = Array.from(
    new Set(
      (html.match(/https:\/\/cdn8\.newbeebox\.com\/mod\/[^"'\s<>]+?\.(?:jpg|jpeg|png|webp)/gi) || [])
        .filter((url) => !/\/icon\//i.test(url) && !/avatar/i.test(url))
        .slice(0, 12),
    ),
  );

  let versions = [];
  try {
    const changelog = await fetchJson(
      `${WEB_BASE}/api/changelog/${numericId}?version=${version}`,
      {
        headers: { Referer: `${WEB_BASE}/games/1/PluginItem/${numericId}?version=${version}` },
        timeout: 20000,
        retries: 1,
      },
    );
    versions = (changelog.list || []).map((entry) => ({
      version: cleanText(entry.name).replace(/\.zip$/i, ''),
      date: normalizeDate(entry.date),
      size: Number(entry.size || 0),
      label: cleanText(entry.label || ''),
      compatible: Array.isArray(entry.versions) ? entry.versions : [],
      notes: stripHtml(entry.text || ''),
    }));
  } catch {
    versions = [];
  }

  const result = {
    key: `wclbox:${numericId}`,
    source: 'wclbox',
    sourceLabel: '新手盒子',
    id: numericId,
    name: title || `插件 ${numericId}`,
    summary: stripHtml(descriptionHtml).slice(0, 700),
    description: stripHtml(descriptionHtml),
    descriptionHtml,
    author: aside['作者'] || '',
    icon: extractMeta(html, 'og:image') || screenshots[0] || '',
    screenshots,
    language: knownLanguage(title, descriptionHtml) || '',
    version: cleanText(currentVersion),
    updatedAt: normalizeDate(aside['更新日期']),
    size: aside['文件大小'] || '',
    downloads: Number(String(aside['下载'] || '').replace(/[^\d]/g, '')) || 0,
    downloadsText: aside['下载'] || '',
    compatible: aside['兼容版本'] ? [aside['兼容版本']] : [],
    categories: [],
    officialUrl: '',
    url: `${WEB_BASE}/games/1/PluginItem/${numericId}?version=${version}`,
    downloadPath,
    versions,
    aside,
  };
  cacheSet(key, result, 3 * 60 * 1000);
  return result;
}

async function latest(id, options = {}) {
  const version = Number(options.version) || DEFAULT_VERSION;
  const numericId = String(id || '').replace(/\D/g, '');
  if (!numericId) throw new AppError('无效的插件 ID', 'BAD_ID', 400);
  const key = `latest:${version}:${numericId}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const data = await fetchJson(
    `${WEB_BASE}/api/changelog/${numericId}?version=${version}`,
    {
      headers: { Referer: `${WEB_BASE}/games/1/PluginItem/${numericId}?version=${version}` },
      timeout: 20000,
      retries: 1,
    },
  );
  const list = Array.isArray(data.list) ? data.list : [];
  const stable = list.find(
    (entry) => !/beta|测试|ptr/i.test(`${entry.name || ''} ${entry.label || ''}`),
  );
  const entry = stable || list[0] || null;
  const result = entry
    ? {
        version: cleanText(entry.name).replace(/\.zip$/i, ''),
        date: normalizeDate(entry.date),
        size: Number(entry.size || 0),
        label: cleanText(entry.label || ''),
        compatible: Array.isArray(entry.versions) ? entry.versions : [],
        isBeta: !stable && Boolean(entry),
      }
    : { version: '', date: '', size: 0, label: '', compatible: [], isBeta: false };
  cacheSet(key, result, 5 * 60 * 1000);
  return result;
}

async function download(id, options = {}) {
  const version = Number(options.version) || DEFAULT_VERSION;
  const numericId = String(id || '').replace(/\D/g, '');
  if (!numericId) throw new AppError('无效的插件 ID', 'BAD_ID', 400);
  const data = await fetchJson(
    `${WEB_BASE}/api/download/PluginItem/${numericId}?version=${version}`,
    {
      headers: {
        Referer: `${WEB_BASE}/games/1/PluginItem/${numericId}?version=${version}`,
        Accept: 'application/json',
      },
      timeout: 25000,
      retries: 1,
    },
  );
  if (!data?.url) throw new AppError('新手盒子暂未提供该插件的下载地址', 'NO_DOWNLOAD', 404);
  const url = new URL(data.url);
  if (url.protocol !== 'https:') throw new AppError('下载地址不安全，已阻止', 'UNSAFE_URL', 400);
  return {
    url: url.toString(),
    name: data.name || `wclbox-${numericId}.zip`,
    size: Number(data.size || 0),
  };
}

async function test() {
  const started = Date.now();
  await post('/web/mod/list', { versions: DEFAULT_VERSION, category: 0, order: 'ranking', offset: 0, filter: '' });
  return { ok: true, latency: Date.now() - started, message: '新手盒子连接正常' };
}

module.exports = {
  id: 'wclbox',
  label: '新手盒子',
  description: '中文插件目录，默认关闭；需要时可在设置中开启',
  search,
  detail,
  latest,
  download,
  test,
  mapItem,
};
