'use strict';

const wclbox = require('./wclbox');
const curseforge = require('./curseforge');
const tukui = require('./tukui');
const wowinterface = require('./wowinterface');
const github = require('./github');
const { AppError } = require('../lib/errors');
const { normalizeName } = require('../lib/utils');
const { matchesCategory } = require('../categories');

const providers = { wclbox, curseforge, tukui, wowinterface, github };

function getProvider(id) {
  const provider = providers[id];
  if (!provider) throw new AppError(`未知的插件来源：${id}`, 'BAD_SOURCE', 400);
  return provider;
}

function providerContext(settings = {}) {
  return {
    apiKey: settings.curseforgeApiKey || '',
    version: Number(settings.wclboxVersion) || 4,
    settings,
  };
}

function isConfigured(id, settings = {}) {
  if (id === 'curseforge') return Boolean(String(settings.curseforgeApiKey || '').trim());
  return true;
}

function isEnabled(id, settings = {}) {
  return Boolean(settings.sources?.[id]) && isConfigured(id, settings);
}

function sourceList(settings = {}) {
  const order = ['curseforge', 'tukui', 'wowinterface', 'wclbox', 'github'];
  return order.map((id) => {
    const provider = providers[id];
    return {
      id: provider.id,
      label: provider.label,
      description: provider.description,
      kind:
        provider.id === 'wclbox'
          ? 'firstparty'
          : provider.id === 'github'
            ? 'community'
            : 'official',
      enabled: Boolean(settings.sources?.[provider.id]),
      configured: isConfigured(provider.id, settings),
      requiresKey: Boolean(provider.requiresKey),
      experimental: Boolean(provider.experimental),
    };
  });
}

function sanitizeResult(result) {
  if (!result) return null;
  return {
    ...result,
    items: Array.isArray(result.items) ? result.items : [],
  };
}

async function search(options = {}, settings = {}) {
  const requested = options.source && options.source !== 'all' ? options.source : null;
  const sourceOrder = ['curseforge', 'tukui', 'wowinterface', 'wclbox', 'github'];
  const ids = requested
    ? [requested]
    : sourceOrder.filter((id) => isEnabled(id, settings));
  if (!ids.length) {
    throw new AppError('没有启用任何插件来源，请先到设置中开启', 'NO_SOURCES', 400);
  }
  const requestedVersion = options.version === 'all'
    ? 'all'
    : Number(options.version) || Number(settings.browseVersion) || Number(settings.wclboxVersion) || 4;
  const wclboxVersion = requestedVersion === 'all'
    ? Number(settings.wclboxVersion) || 4
    : requestedVersion;
  const ctx = providerContext(settings);
  const settled = await Promise.allSettled(
    ids.map(async (id) => {
      const provider = getProvider(id);
      if (id === 'curseforge' && !isConfigured(id, settings)) {
        throw new AppError('未配置 CurseForge API Key', 'CF_NO_KEY', 400);
      }
      let result = await provider.search(
        {
          query: options.query || '',
          categoryKey: options.category || 'all',
          category: options.category || 0,
          page: options.page || 1,
          sort: options.sort || settings.sort || 'popular',
          version: wclboxVersion,
        },
        ctx,
      );
      result = sanitizeResult(result);
      const categoryKey = String(options.category || 'all');
      if (categoryKey !== 'all' && result.categoryApplied !== true) {
        result.items = result.items.filter((item) => matchesCategory(item, categoryKey));
        result.total = result.items.length;
        result.categoryFilteredLocally = true;
      }
      return result;
    }),
  );

  const groups = settled.map((entry, index) => {
    const id = ids[index];
    const provider = getProvider(id);
    if (entry.status === 'fulfilled') {
      return {
        id,
        label: provider.label,
        ok: true,
        total: entry.value.total,
        count: entry.value.items.length,
        error: '',
      };
    }
    return {
      id,
      label: provider.label,
      ok: false,
      total: 0,
      count: 0,
      error: entry.reason?.message || '加载失败',
      code: entry.reason?.code || 'ERROR',
    };
  });

  const deduped = new Map();
  for (const entry of settled) {
    if (entry.status !== 'fulfilled') continue;
    for (const item of entry.value.items) {
      const key = `${item.source}:${item.id}`;
      if (!deduped.has(key)) deduped.set(key, item);
    }
  }
  const items = Array.from(deduped.values());
  if (!requested) {
    const officialRank =
      Number(settings.wclboxVersion) === 9
        ? { wclbox: 0, tukui: 1, curseforge: 2, wowinterface: 3, github: 4 }
        : { curseforge: 0, tukui: 1, wowinterface: 2, wclbox: 3, github: 4 };
    items.sort((a, b) => {
      if (options.query) {
        const qa = normalizeName(a.name).includes(normalizeName(options.query)) ? 1 : 0;
        const qb = normalizeName(b.name).includes(normalizeName(options.query)) ? 1 : 0;
        if (qa !== qb) return qb - qa;
      }
      const rankA = officialRank[a.source] ?? 5;
      const rankB = officialRank[b.source] ?? 5;
      if (rankA !== rankB) return rankA - rankB;
      return (b.downloads || b.favorites || 0) - (a.downloads || a.favorites || 0);
    });
  }
  return {
    query: options.query || '',
    source: requested || 'all',
    items,
    groups,
    total: groups.reduce((sum, group) => sum + (group.total || 0), 0),
    page: Number(options.page) || 1,
  };
}

async function detail(source, id, settings = {}) {
  const provider = getProvider(source);
  return provider.detail(id, providerContext(settings));
}

async function latest(source, id, settings = {}) {
  const provider = getProvider(source);
  return provider.latest(id, providerContext(settings));
}

async function download(source, id, settings = {}) {
  const provider = getProvider(source);
  return provider.download(id, providerContext(settings));
}

async function test(id, settings = {}) {
  const provider = getProvider(id);
  return provider.test(providerContext(settings));
}

module.exports = {
  providers,
  getProvider,
  providerContext,
  sourceList,
  isConfigured,
  isEnabled,
  search,
  detail,
  latest,
  download,
  test,
};
