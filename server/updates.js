'use strict';

const providers = require('./providers');
const wow = require('./wow');
const store = require('./lib/store');
const { AppError } = require('./lib/errors');
const {
  cleanText,
  compareVersions,
  isVersionNewer,
  mapLimit,
  normalizeName,
} = require('./lib/utils');
const { groupInstalledAddons } = require('./lib/group');

function normalizeTitle(addon) {
  return normalizeName(addon.name || addon.title || addon.baseFolder);
}

function isLikelyMatch(addon, candidate) {
  const a = normalizeTitle(addon);
  const b = normalizeName(candidate.name || '');
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  const folder = normalizeName(addon.baseFolder);
  return Boolean(folder && (folder === b || folder.includes(b) || b.includes(folder)));
}

async function findWclbox(addon, settings) {
  if (settings.sources?.wclbox === false) return null;
  const query = addon.name || addon.baseFolder;
  const result = await providers.providers.wclbox.search(
    { query, page: 1, version: settings.wclboxVersion || 4, sort: 'ranking' },
    settings,
  );
  const candidate = result.items.find((item) => isLikelyMatch(addon, item));
  if (!candidate) return null;
  const latest = await providers.providers.wclbox.latest(candidate.id, settings);
  return {
    source: 'wclbox',
    sourceLabel: '新手盒子',
    id: candidate.id,
    name: candidate.name,
    version: latest.version,
    date: latest.date,
    label: latest.label,
    icon: candidate.icon,
    url: candidate.url,
    candidate,
    isBeta: latest.isBeta,
  };
}

async function findTukui(addon, settings) {
  if (settings.sources?.tukui === false) return null;
  const result = await providers.providers.tukui.search(
    { query: addon.name || addon.baseFolder },
    settings,
  );
  const candidate = result.items.find((item) => isLikelyMatch(addon, item));
  if (!candidate) return null;
  const latest = await providers.providers.tukui.latest(candidate.id, settings);
  return {
    source: 'tukui',
    sourceLabel: 'Tukui',
    id: candidate.id,
    name: candidate.name,
    version: latest.version,
    date: latest.date,
    label: '',
    icon: candidate.icon,
    url: candidate.url,
    candidate,
    isBeta: false,
  };
}

async function findCurseForge(addon, settings) {
  if (!settings.curseforgeApiKey || settings.sources?.curseforge === false) return null;
  if (addon.curseProjectId) {
    const latest = await providers.providers.curseforge.latest(addon.curseProjectId, settings);
    return {
      source: 'curseforge',
      sourceLabel: 'CurseForge',
      id: addon.curseProjectId,
      name: addon.name,
      version: latest.version,
      date: latest.date,
      label: latest.label,
      icon: '',
      url: `https://www.curseforge.com/wow/addons/${addon.curseProjectId}`,
      isBeta: latest.isBeta,
    };
  }
  const result = await providers.providers.curseforge.search(
    { query: addon.name || addon.baseFolder, page: 1 },
    settings,
  );
  const candidate = result.items.find((item) => isLikelyMatch(addon, item));
  if (!candidate) return null;
  const latest = await providers.providers.curseforge.latest(candidate.id, settings);
  return {
    source: 'curseforge',
    sourceLabel: 'CurseForge',
    id: candidate.id,
    name: candidate.name,
    version: latest.version,
    date: latest.date,
    label: latest.label,
    icon: candidate.icon,
    url: candidate.url,
    candidate,
    isBeta: latest.isBeta,
  };
}

async function findRemote(addon, settings) {
  if (addon.managed?.source && addon.managed?.remoteId) {
    const source = addon.managed.source;
    if (providers.providers[source]) {
      const latest = await providers.latest(source, addon.managed.remoteId, settings);
      return {
        source,
        sourceLabel: providers.getProvider(source).label,
        id: addon.managed.remoteId,
        name: addon.managed.remoteName || addon.name,
        version: latest.version,
        date: latest.date,
        label: latest.label,
        icon: addon.managed.icon || '',
        url: '',
        isBeta: latest.isBeta,
        managed: true,
      };
    }
  }
  const errors = [];
  for (const finder of [findCurseForge, findTukui, findWclbox]) {
    try {
      const found = await finder(addon, settings);
      if (found) return found;
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (settings.sources?.wowinterface && addon.wowInterfaceId) {
    try {
      const latest = await providers.latest('wowinterface', addon.wowInterfaceId, settings);
      return {
        source: 'wowinterface',
        sourceLabel: 'WoWInterface',
        id: addon.wowInterfaceId,
        name: addon.name,
        version: latest.version,
        date: latest.date,
        label: '',
        icon: '',
        url: `https://www.wowinterface.com/downloads/info${addon.wowInterfaceId}`,
        isBeta: false,
      };
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (errors.length) {
    const error = new AppError(errors[0], 'MATCH_FAILED', 502);
    error.matchErrors = errors;
    throw error;
  }
  return null;
}

function comparisonVersion(addon) {
  // Managed packages can use a different numbering scheme in their TOC
  // (for example Lueur ships a date-based package version while the TOC
  // still says 1.4.0). Compare against the version that was actually
  // installed from the provider, otherwise the same package is reported
  // as updatable forever.
  const managedVersion = cleanText(addon.managed?.remoteVersion || '');
  return managedVersion || addon.version;
}

function statusFor(addon, remote) {
  if (!remote) return 'unknown';
  const installed = comparisonVersion(addon);
  if (!installed) return 'unknown';
  const comparison = compareVersions(remote.version, installed);
  if (comparison === null) {
    return cleanText(remote.version).toLowerCase() === cleanText(installed).toLowerCase()
      ? 'current'
      : 'unknown';
  }
  if (comparison > 0) return 'update';
  return 'current';
}

async function checkAddon(addon, settings) {
  if (addon.managed?.pinned) {
    return {
      folder: addon.baseFolder,
      addon,
      status: 'pinned',
      remote: null,
      installedVersion: addon.version,
    };
  }
  try {
    const remote = await findRemote(addon, settings);
    return {
      folder: addon.baseFolder,
      addon,
      status: statusFor(addon, remote),
      remote,
      installedVersion: addon.version,
    };
  } catch (error) {
    return {
      folder: addon.baseFolder,
      addon,
      status: 'error',
      remote: null,
      installedVersion: addon.version,
      error: error.message,
    };
  }
}

async function checkAll(options = {}) {
  const settings = store.loadSettings();
  const target = await wow.resolveAddonPath(settings);
  if (!target.exists) {
    throw new AppError('还没有找到魔兽世界插件目录，请先在设置中选择游戏路径', 'NO_ADDON_PATH', 400);
  }
  const scan = await wow.scanAddons(target.addonPath, target.folder, { force: true });
  const rawAddons = scan.addons.filter((addon) => !addon.isLibrary || options.includeLibraries);
  const grouped = groupInstalledAddons(rawAddons);
  const addons = grouped.map((group) => group.primary).filter(Boolean);
  const results = [];
  let done = 0;
  await mapLimit(addons, 4, async (addon) => {
    const result = await checkAddon(addon, settings);
    result.group = grouped.find((group) => group.primary === addon) || null;
    results.push(result);
    done += 1;
    if (options.onProgress) options.onProgress({ done, total: addons.length, addon: addon.name });
  });
  const order = { update: 0, error: 1, unknown: 2, current: 3, pinned: 4 };
  results.sort((a, b) => order[a.status] - order[b.status] || a.addon.name.localeCompare(b.addon.name));
  store.saveSettings({ lastCheckAt: new Date().toISOString() });
  return {
    addonPath: target.addonPath,
    checkedAt: new Date().toISOString(),
    results,
    counts: {
      total: results.length,
      update: results.filter((entry) => entry.status === 'update').length,
      current: results.filter((entry) => entry.status === 'current').length,
      unknown: results.filter((entry) => entry.status === 'unknown').length,
      pinned: results.filter((entry) => entry.status === 'pinned').length,
      error: results.filter((entry) => entry.status === 'error').length,
    },
  };
}

module.exports = { checkAll, checkAddon, findRemote, statusFor, isLikelyMatch, isVersionNewer };
