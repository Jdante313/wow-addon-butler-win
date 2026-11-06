'use strict';

const { fetchJson } = require('../lib/http');
const { AppError } = require('../lib/errors');
const { cleanText, normalizeDate, stripHtml } = require('../lib/utils');
const { knownLanguage } = require('../lib/language');
const { curseforgeCategoryNames } = require('../categories');

const API = 'https://api.curseforge.com/v1';
const CACHE_TTL = 4 * 60 * 1000;
let categoryCache = null;

function getKey(ctx = {}) {
  const key = String(ctx.apiKey || '').trim();
  if (!key) {
    throw new AppError(
      '尚未配置 CurseForge API Key，请到设置中填写后使用',
      'CF_NO_KEY',
      400,
    );
  }
  return key;
}

async function cf(path, ctx, options = {}) {
  try {
    return await fetchJson(`${API}${path}`, {
      ...options,
      headers: {
        'x-api-key': getKey(ctx),
        Accept: 'application/json',
        ...(options.headers || {}),
      },
      timeout: 30000,
      retries: 1,
    });
  } catch (error) {
    if (
      error.status === 401 ||
      error.status === 403 ||
      /api key missing|invalid|unauthor|forbidden/i.test(error.message || '')
    ) {
      throw new AppError(
        'CurseForge API Key 无效、已过期或复制不完整。请点控制台 Key 右侧的复制按钮复制完整内容；如果仍失败，点 Regenerate 生成新 Key 后立即粘贴到设置中。',
        'CF_INVALID_KEY',
        400,
      );
    }
    throw error;
  }
}

async function categories(ctx) {
  if (categoryCache && categoryCache.expires > Date.now()) return categoryCache.value;
  const data = await cf('/categories?gameId=1', ctx);
  const map = new Map((data.data || []).map((cat) => [cat.id, cat.name]));
  categoryCache = { value: map, expires: Date.now() + 60 * 60 * 1000 };
  return map;
}

function latestFile(mod) {
  const files = Array.isArray(mod.latestFiles) ? mod.latestFiles.slice() : [];
  files.sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate));
  return files.find((file) => file.releaseType === 1) || files[0] || null;
}

function mapMod(mod, categoryMap) {
  const file = latestFile(mod);
  const screenshots = Array.isArray(mod.screenshots)
    ? mod.screenshots.map((shot) => shot.thumbnailUrl || shot.url).filter(Boolean)
    : [];
  const categoriesList = Array.isArray(mod.categories)
    ? mod.categories.map((cat) => categoryMap.get(cat.id) || cat.name).filter(Boolean)
    : [];
  return {
    key: `curseforge:${mod.id}`,
    source: 'curseforge',
    sourceLabel: 'CurseForge',
    id: String(mod.id),
    name: cleanText(mod.name),
    summary: stripHtml(mod.summary || '').slice(0, 700),
    description: stripHtml(mod.summary || ''),
    author: cleanText(mod.authors?.[0]?.name || 'CurseForge'),
    icon: mod.logo?.thumbnailUrl || mod.logo?.url || screenshots[0] || '',
    screenshots: screenshots.slice(0, 8),
    version: cleanText(file?.displayName || file?.fileName || ''),
    fileName: cleanText(file?.fileName || ''),
    fileId: file?.id,
    updatedAt: normalizeDate(file?.fileDate || mod.dateModified),
    downloads: Number(mod.downloadCount || 0),
    favorites: 0,
    categories: categoriesList,
    compatible: Array.isArray(file?.gameVersions) ? file.gameVersions : [],
    language: knownLanguage(mod.name, mod.summary) || '',
    size: Number(file?.fileLength || 0),
    officialUrl: mod.links?.websiteUrl || '',
    url: mod.links?.websiteUrl || '',
    allowDownload: Boolean(file?.downloadUrl || file?.id),
    directory: cleanText(file?.fileName || '').replace(/\.zip$/i, ''),
    raw: { classId: mod.classId, gameId: mod.gameId },
  };
}

async function search(options = {}, ctx = {}) {
  const query = cleanText(options.query || '');
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = 20;
  const categoryMap = await categories(ctx).catch(() => new Map());
  const categoryKey = String(options.categoryKey || 'all');
  let categoryId = '';
  if (categoryKey !== 'all') {
    const aliases = curseforgeCategoryNames(categoryKey).map((name) => name.toLowerCase());
    for (const [id, name] of categoryMap.entries()) {
      const lower = String(name || '').toLowerCase();
      if (aliases.some((alias) => lower === alias || lower.includes(alias))) {
        categoryId = String(id);
        break;
      }
    }
  }
  const sortField = { popular: '6', hot: '6', updated: '3', name: '4', ranking: '2' }[options.sort] || '6';
  const params = new URLSearchParams({
    gameId: '1',
    searchFilter: query,
    sortField,
    sortOrder: 'desc',
    pageSize: String(pageSize),
    index: String((page - 1) * pageSize),
  });
  if (categoryId) params.set('categoryId', categoryId);
  const data = await cf(`/mods/search?${params.toString()}`, ctx);
  return {
    source: 'curseforge',
    sourceLabel: 'CurseForge',
    total: Number(data.pagination?.totalCount || 0),
    page,
    pageSize,
    hasMore: Boolean(data.pagination?.totalCount > page * pageSize),
    categoryApplied: Boolean(categoryId),
    items: (data.data || []).map((mod) => mapMod(mod, categoryMap)),
  };
}

async function detail(id, ctx = {}) {
  const data = await cf(`/mods/${encodeURIComponent(id)}`, ctx);
  const categoryMap = await categories(ctx).catch(() => new Map());
  const mapped = mapMod(data.data, categoryMap);
  try {
    const files = await cf(`/mods/${encodeURIComponent(id)}/files?pageSize=20`, ctx);
    mapped.versions = (files.data || []).map((file) => ({
      version: cleanText(file.displayName || file.fileName),
      date: normalizeDate(file.fileDate),
      size: Number(file.fileLength || 0),
      label: file.releaseType === 3 ? '测试版' : '',
      compatible: Array.isArray(file.gameVersions) ? file.gameVersions : [],
      notes: '',
    }));
  } catch {
    mapped.versions = [];
  }
  if (data.data?.description) {
    mapped.descriptionHtml = data.data.description;
    mapped.description = stripHtml(data.data.description);
  }
  return mapped;
}

async function latest(id, ctx = {}) {
  const data = await cf(`/mods/${encodeURIComponent(id)}`, ctx);
  const file = latestFile(data.data);
  if (!file) throw new AppError('CurseForge 上没有可用文件', 'NO_FILES', 404);
  return {
    version: cleanText(file.displayName || file.fileName),
    date: normalizeDate(file.fileDate),
    size: Number(file.fileLength || 0),
    label: file.releaseType === 3 ? '测试版' : '',
    compatible: Array.isArray(file.gameVersions) ? file.gameVersions : [],
    isBeta: file.releaseType === 3,
    fileId: file.id,
    fileName: file.fileName,
  };
}

async function download(id, ctx = {}) {
  const mod = await cf(`/mods/${encodeURIComponent(id)}`, ctx);
  const file = latestFile(mod.data);
  if (!file) throw new AppError('CurseForge 上没有可用文件', 'NO_FILES', 404);
  if (file.downloadUrl) {
    return {
      url: file.downloadUrl,
      name: file.fileName || `curseforge-${id}.zip`,
      size: Number(file.fileLength || 0),
    };
  }
  const data = await cf(
    `/mods/${encodeURIComponent(id)}/files/${encodeURIComponent(file.id)}/download-url`,
    ctx,
  );
  if (!data.data) {
    throw new AppError(
      '作者未授权第三方下载此文件，请前往 CurseForge 网页手动下载',
      'CF_DOWNLOAD_FORBIDDEN',
      403,
    );
  }
  return {
    url: data.data,
    name: file.fileName || `curseforge-${id}.zip`,
    size: Number(file.fileLength || 0),
  };
}

async function test(ctx = {}) {
  const started = Date.now();
  // /games/1 is public and cannot validate a key. Use an authenticated
  // search endpoint so a bad key is reported instead of a false success.
  await cf('/mods/search?gameId=1&pageSize=1&index=0', ctx);
  return { ok: true, latency: Date.now() - started, message: 'CurseForge API Key 有效，连接正常' };
}

module.exports = {
  id: 'curseforge',
  label: 'CurseForge',
  description: '全球最大的官方插件平台，需要免费 API Key',
  requiresKey: true,
  search,
  detail,
  latest,
  download,
  test,
};
