'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const {
  APP_ROOT,
  APP_NAME,
  APP_VERSION,
  DATA_DIR,
  BACKUP_DIR,
  PROFILE_DIR,
  FLAVORS,
} = require('./config');
const { AppError, asError } = require('./lib/errors');
const { isSubPath, normalizeName, pathExistsSync } = require('./lib/utils');
const store = require('./lib/store');
const wow = require('./wow');
const providers = require('./providers');
const tasks = require('./tasks');
const profiles = require('./profiles');
const dialogs = require('./lib/dialogs');
const match = require('./lib/match');
const runtimeState = require('./lib/runtime-state');
const { groupInstalledAddons, groupedStats } = require('./lib/group');
const { SEARCH_CATEGORIES, getCategory } = require('./categories');

const RENDERER_DIR = path.join(APP_ROOT, 'renderer');
const ASSETS_DIR = path.join(APP_ROOT, 'assets');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

let installationsCache = null;
let installationsCacheAt = 0;

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function ok(res, data = {}) {
  json(res, 200, { ok: true, data });
}

function fail(res, error) {
  const appError = asError(error);
  json(res, appError.status || 500, {
    ok: false,
    error: {
      message: appError.message,
      code: appError.code,
      details: appError.details || null,
    },
  });
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError('请求内容过大', 'BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('请求格式错误', 'BAD_JSON', 400);
  }
}

async function detectCached(force = false) {
  if (!force && installationsCache && Date.now() - installationsCacheAt < 30000) {
    return installationsCache;
  }
  installationsCache = await wow.detectInstallations();
  installationsCacheAt = Date.now();
  return installationsCache;
}

function clearCaches() {
  installationsCache = null;
  installationsCacheAt = 0;
  wow.invalidateScan();
}

function flattenClients(installations, target) {
  const clients = [];
  const seen = new Set();
  for (const installation of installations || []) {
    for (const flavor of installation.flavors || []) {
      const key = flavor.addonPath || `${installation.root}/${flavor.folder}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clients.push({
        ...flavor,
        root: installation.root,
        current: Boolean(target?.addonPath && key === target.addonPath),
      });
    }
  }
  if (!clients.length && target?.addonPath) {
    clients.push({
      key: target.flavor,
      folder: target.folder,
      label: FLAVORS[target.flavor]?.label || '自定义客户端',
      hint: '手动设置的插件目录',
      addonPath: target.addonPath,
      addonPathExists: target.exists,
      exists: target.exists,
      version: target.version || '',
      versionShort: String(target.version || '').split('.').slice(0, 2).join('.'),
      addonCount: 0,
      root: target.root || '',
      current: true,
    });
  } else if (!clients.some((client) => client.current) && target?.addonPath) {
    const existing = clients.find((client) => client.addonPath === target.addonPath);
    if (existing) existing.current = true;
    else {
      clients.push({
        key: target.flavor,
        folder: target.folder,
        label: FLAVORS[target.flavor]?.label || '当前客户端',
        hint: '手动设置的插件目录',
        addonPath: target.addonPath,
        addonPathExists: target.exists,
        exists: target.exists,
        version: target.version || '',
        versionShort: '',
        addonCount: 0,
        root: target.root || '',
        current: true,
      });
    }
  }
  return clients;
}

async function buildClientPayload(settings) {
  const target = await wow.resolveAddonPath(settings);
  const installations = await detectCached(false);
  return { target, installations, clients: flattenClients(installations, target) };
}

function decorateItems(items, scan, managed) {
  if (!Array.isArray(items)) return [];
  const packages = Object.values(managed?.packages || {});
  return items.map((item) => {
    const managedPackage = packages.find(
      (pkg) => pkg.source === item.source && String(pkg.remoteId) === String(item.id),
    );
    const byManaged = managedPackage
      ? (scan?.addons || []).filter((addon) =>
          managedPackage.folders?.some(
            (folder) => String(folder).toLowerCase() === addon.baseFolder.toLowerCase(),
          ),
        )
      : [];
    const itemName = normalizeName(item.name);
    const matches = byManaged.length
      ? byManaged
      : (scan?.addons || []).filter(
          (addon) =>
            normalizeName(addon.name) === itemName ||
            normalizeName(addon.baseFolder) === itemName ||
            normalizeName(addon.title) === itemName,
        );
    return {
      ...item,
      language: matches[0]?.language || item.language || '',
      installed: matches.length
        ? {
            folders: matches.map((addon) => addon.baseFolder),
            version: matches[0].version,
            enabled: matches.every((addon) => addon.enabled),
          }
        : null,
    };
  });
}

async function aimScan(target, force = false) {
  if (!target?.addonPath) {
    return Promise.resolve({
      addonPath: '',
      exists: false,
      addons: [],
      stats: { total: 0, enabled: 0, disabled: 0, libraries: 0 },
    });
  }
  return wow.scanAddons(target.addonPath, target.folder, { force });
}

async function autoAdoptClient(settings, target) {
  if (settings.addonPath || !target?.addonPath || !target.root) return settings;
  if (!pathExistsSync(target.root)) return settings;
  return store.saveSettings({
    addonPath: target.addonPath,
    wowRoot: target.root,
    flavor: target.flavor,
    wclboxVersion: FLAVORS[target.flavor]?.wclbox || settings.wclboxVersion,
    browseVersion: 0,
  });
}

function validateAddonPath(input) {
  const resolved = path.resolve(String(input || ''));
  if (!/interface[\\/]addons$/i.test(resolved)) {
    throw new AppError('插件目录必须以 Interface/AddOns 结尾', 'BAD_ADDON_PATH', 400);
  }
  return resolved;
}

function folderFromAddonPath(addonPath) {
  return path.basename(path.dirname(path.dirname(path.resolve(addonPath))));
}

function rootFromAddonPath(addonPath) {
  return path.dirname(path.dirname(path.dirname(path.resolve(addonPath))));
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method || 'GET';
  let settings = store.loadSettings();

  if (pathname === '/api/health' && method === 'GET') {
    return ok(res, { app: APP_NAME, version: APP_VERSION, time: new Date().toISOString() });
  }

  if (pathname === '/api/bootstrap' && method === 'GET') {
    const target = await wow.resolveAddonPath(settings);
    settings = await autoAdoptClient(settings, target);
    const [scan, installations] = await Promise.all([
      aimScan(target, searchParams.get('refresh') === '1'),
      detectCached(searchParams.get('refresh') === '1'),
    ]);
    return ok(res, {
      settings: store.publicSettings(),
      target,
      scan: {
        addonPath: scan.addonPath,
        exists: scan.exists,
        stats: groupedStats(groupInstalledAddons(scan.addons), scan.stats),
        folderStats: scan.stats,
        scannedAt: scan.scannedAt,
      },
      installations,
      clients: flattenClients(installations, target),
      sources: providers.sourceList(settings),
      categories: SEARCH_CATEGORIES.map((category) => ({
        key: category.key,
        label: category.label,
        short: category.short,
      })),
      browseVersions: [
        'unlimited',
        'retail',
        'titan',
        'classic',
        'sod',
        'mists',
        'tbc',
        'anniversary',
      ]
        .filter((key) => FLAVORS[key])
        .map((key) => ({
          key,
          label: FLAVORS[key].label,
          short: FLAVORS[key].short,
          wclbox: FLAVORS[key].wclbox,
        })),
      lastCheck: runtimeState.getLastCheck() || null,
      wowRunning: await wow.isWowRunning(),
    });
  }

  if (pathname === '/api/clients' && method === 'GET') {
    const { clients, target } = await buildClientPayload(settings);
    return ok(res, { clients, target });
  }

  if (pathname === '/api/select-client' && method === 'POST') {
    const body = await readBody(req);
    const addonPath = validateAddonPath(body.addonPath);
    const clientDir = path.dirname(path.dirname(addonPath));
    if (!pathExistsSync(clientDir)) {
      throw new AppError('这个客户端目录不存在，请重新选择游戏目录', 'BAD_CLIENT_PATH', 400);
    }
    const folder = folderFromAddonPath(addonPath);
    const knownFlavor = Object.keys(FLAVORS).find(
      (key) =>
        FLAVORS[key].folder === folder || (FLAVORS[key].folders || []).includes(folder),
    );
    const flavor = FLAVORS[body.flavor] ? body.flavor : knownFlavor || 'custom';
    settings = store.saveSettings({
      addonPath,
      wowRoot: rootFromAddonPath(addonPath),
      flavor,
      wclboxVersion: FLAVORS[flavor]?.wclbox || settings.wclboxVersion,
      browseVersion: 0,
    });
    clearCaches();
    const target = await wow.resolveAddonPath(settings);
    const scan = await aimScan(target, true);
    const installations = await detectCached(true);
    return ok(res, {
      settings: store.publicSettings(),
      target,
      scan: {
        addonPath: scan.addonPath,
        exists: scan.exists,
        stats: groupedStats(groupInstalledAddons(scan.addons), scan.stats),
        scannedAt: scan.scannedAt,
      },
      clients: flattenClients(installations, target),
    });
  }

  if (pathname === '/api/resolve-folder' && method === 'POST') {
    const body = await readBody(req);
    const picked = path.resolve(String(body.path || ''));
    if (!pathExistsSync(picked)) throw new AppError('这个文件夹不存在', 'NOT_FOUND', 404);
    const candidates = [];
    const addonLike = /interface[\\/]addons$/i.test(picked)
      ? picked
      : path.join(picked, 'Interface', 'AddOns');
    if (pathExistsSync(addonLike) || /interface[\\/]addons$/i.test(picked)) {
      const folder = folderFromAddonPath(addonLike);
      const knownFlavor = Object.keys(FLAVORS).find(
        (key) => FLAVORS[key].folder === folder || (FLAVORS[key].folders || []).includes(folder),
      );
      candidates.push({
        addonPath: addonLike,
        folder,
        flavor: knownFlavor || 'custom',
        label: FLAVORS[knownFlavor]?.label || folder,
        exists: pathExistsSync(addonLike),
      });
    }
    const flavors = await wow.detectFlavors(picked);
    for (const flavor of flavors) {
      if (candidates.some((entry) => entry.addonPath === flavor.addonPath)) continue;
      candidates.push({
        addonPath: flavor.addonPath,
        folder: flavor.folder,
        flavor: flavor.key,
        label: flavor.label,
        version: flavor.version || '',
        versionShort: flavor.versionShort || '',
        exists: flavor.exists,
      });
    }
    if (!candidates.length) {
      throw new AppError(
        '这个文件夹里没有找到 Interface/AddOns，请选择 World of Warcraft 安装目录或 _retail_ / _forever_ 客户端目录',
        'NO_CLIENT',
        400,
      );
    }
    return ok(res, { candidates });
  }

  if (pathname === '/api/search' && method === 'GET') {
    const query = String(searchParams.get('q') || '').trim();
    const source = searchParams.get('source') || 'all';
    const page = Math.max(1, Number(searchParams.get('page')) || 1);
    const category = getCategory(searchParams.get('category') || 'all').key;
    const sortParam = searchParams.get('sort') || settings.sort || 'popular';
    const sort = ['popular', 'updated', 'name'].includes(sortParam) ? sortParam : 'popular';
    const version =
      searchParams.get('version') || settings.browseVersion || settings.wclboxVersion;
    const result = await providers.search(
      { query, source, page, sort, category, version },
      settings,
    );
    const target = await wow.resolveAddonPath(settings);
    const scan = await aimScan(target, false);
    const decorated = decorateItems(result.items, scan, store.loadManaged());
    const items = query
      ? decorated.map((item) => match.classifyItem(item, query))
      : decorated;
    const pageSize = Number(result.pageSize) || 12;
    const loadedEstimate = Math.max(items.length, (page - 1) * pageSize + items.length);
    return ok(res, {
      ...result,
      query,
      category,
      sort,
      items,
      exactCount: query ? items.filter((item) => item.match === 'exact').length : 0,
      fuzzyCount: query ? items.filter((item) => item.match !== 'exact').length : 0,
      page,
      hasMore: Boolean(result.hasMore || (Number(result.total) || 0) > loadedEstimate),
      client: target,
    });
  }

  if (pathname.startsWith('/api/addon/') && method === 'GET') {
    const rest = decodeURIComponent(pathname.slice('/api/addon/'.length));
    const slash = rest.indexOf('/');
    if (slash < 0) throw new AppError('无效的插件地址', 'BAD_PATH', 400);
    const source = rest.slice(0, slash);
    const id = rest.slice(slash + 1);
    const detail = await providers.detail(source, id, settings);
    const target = await wow.resolveAddonPath(settings);
    const scan = await aimScan(target, false);
    return ok(res, decorateItems([detail], scan, store.loadManaged())[0]);
  }

  if (pathname === '/api/installed' && method === 'GET') {
    const target = await wow.resolveAddonPath(settings);
    const scan = await aimScan(target, searchParams.get('refresh') === '1');
    const managed = store.loadManaged();
    const lastCheck = runtimeState.getLastCheck();
    const updateByFolder = new Map(
      (lastCheck?.results || []).map((entry) => [entry.folder?.toLowerCase(), entry]),
    );
    const rawAddons = scan.addons.map((addon) => ({
      ...addon,
      update: updateByFolder.get(addon.baseFolder.toLowerCase()) || null,
    }));
    const addons = groupInstalledAddons(rawAddons, updateByFolder);
    const installations = await detectCached(false);
    const clients = flattenClients(installations, target);
    return ok(res, {
      ...scan,
      addons,
      client: target,
      clients,
      stats: {
        ...groupedStats(addons, scan.stats),
        updates: addons.filter(
          (addon) => addon.update?.status === 'update' && !addon.managed?.pinned,
        ).length,
        managed: addons.filter((addon) => addon.managed).length,
      },
      folderStats: scan.stats,
      managedPackages: Object.values(managed.packages || {}).length,
      lastCheckAt: lastCheck?.checkedAt || settings.lastCheckAt || '',
      lastCheckCounts: lastCheck?.counts || null,
      wowRunning: await wow.isWowRunning(),
      settings: store.publicSettings(),
    });
  }

  if (pathname === '/api/updates' && method === 'GET') {
    return ok(res, runtimeState.getLastCheck() || { results: [], counts: null, checkedAt: '' });
  }

  if (pathname === '/api/check-updates' && method === 'POST') {
    return ok(res, tasks.startCheck());
  }

  if (pathname === '/api/update-all' && method === 'POST') {
    return ok(res, tasks.startUpdateAll());
  }

  if (pathname === '/api/install-local' && method === 'POST') {
    const body = await readBody(req);
    const filePath = path.resolve(String(body.path || ''));
    if (!filePath) throw new AppError('缺少本地插件包路径', 'BAD_REQUEST', 400);
    let stat = null;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      throw new AppError('找不到这个文件，可能已经被移动或删除', 'NOT_FOUND', 404);
    }
    if (!stat.isFile()) throw new AppError('请选择一个 ZIP 压缩包文件', 'NOT_A_FILE', 400);
    if (!/\.(zip|addon)$/i.test(filePath)) {
      throw new AppError('只支持 .zip / .addon 格式的插件压缩包', 'BAD_ZIP', 400);
    }
    if (stat.size > 700 * 1024 * 1024) {
      throw new AppError('插件包超过 700 MB，已阻止安装', 'FILE_TOO_LARGE', 413);
    }
    const target = await wow.resolveAddonPath(settings);
    if (!target.addonPath) {
      throw new AppError('还没有选择魔兽世界客户端，请先到设置里选择游戏目录', 'NO_ADDON_PATH', 400);
    }
    return ok(
      res,
      tasks.startInstallLocal({
        filePath,
        nameHint: path.basename(filePath),
      }),
    );
  }

  if (pathname === '/api/install' && method === 'POST') {
    const body = await readBody(req);
    if (!body.source || !body.id) throw new AppError('缺少插件来源或 ID', 'BAD_REQUEST', 400);
    if (!providers.providers[body.source]) throw new AppError('未知插件来源', 'BAD_SOURCE', 400);
    const target = await wow.resolveAddonPath(settings);
    if (!target.addonPath) {
      throw new AppError('还没有选择魔兽世界客户端，请先到设置里选择游戏目录', 'NO_ADDON_PATH', 400);
    }
    return ok(
      res,
      tasks.startInstall({
        source: body.source,
        id: String(body.id),
        nameHint: body.name || '',
      }),
    );
  }

  if (pathname === '/api/update' && method === 'POST') {
    const body = await readBody(req);
    return ok(res, tasks.startUpdate({ folder: body.folder }));
  }

  if (pathname.startsWith('/api/tasks/') && method === 'GET') {
    return ok(res, tasks.get(pathname.slice('/api/tasks/'.length)));
  }

  const addonMatch = pathname.match(/^\/api\/addons\/([^/]+)(?:\/(pin|backup|open))?$/);
  if (addonMatch) {
    const folder = decodeURIComponent(addonMatch[1]);
    const action = addonMatch[2];
    const target = await wow.resolveAddonPath(settings);
    if (method === 'PATCH' && !action) {
      const body = await readBody(req);
      if (typeof body.enabled !== 'boolean') {
        throw new AppError('缺少 enabled 参数', 'BAD_REQUEST', 400);
      }
      const result = await wow.setEnabled(target.addonPath, folder, body.enabled);
      return ok(res, result);
    }
    if (method === 'DELETE' && !action) {
      const body = await readBody(req);
      const result = await wow.uninstallAddon(target.addonPath, folder, {
        backup: body.backup !== false,
        folders: body.folders,
      });
      return ok(res, result);
    }
    if (method === 'POST' && action === 'pin') {
      const body = await readBody(req);
      const scan = await wow.scanAddons(target.addonPath, target.folder, { force: true });
      const addon = scan.addons.find(
        (entry) => entry.baseFolder.toLowerCase() === folder.toLowerCase(),
      );
      if (!addon?.managed?.packageId) {
        throw new AppError('这个插件没有关联在线来源，暂时无法固定版本', 'NOT_MANAGED', 400);
      }
      const pkg = store.setPinned(addon.managed.packageId, Boolean(body.pinned));
      return ok(res, { package: pkg });
    }
    if (method === 'POST' && action === 'backup') {
      const scan = await wow.scanAddons(target.addonPath, target.folder, { force: true });
      const addon = scan.addons.find(
        (entry) => entry.baseFolder.toLowerCase() === folder.toLowerCase(),
      );
      if (!addon) throw new AppError('插件不存在', 'NOT_FOUND', 404);
      const backup = await wow.createBackup(addon.path, { folder: addon.baseFolder }, 'manual');
      return ok(res, backup);
    }
    if (method === 'POST' && action === 'open') {
      const scan = await wow.scanAddons(target.addonPath, target.folder, { force: true });
      const addon = scan.addons.find(
        (entry) => entry.baseFolder.toLowerCase() === folder.toLowerCase(),
      );
      if (!addon) throw new AppError('插件不存在', 'NOT_FOUND', 404);
      return ok(res, await wow.revealPath(addon.path));
    }
  }

  if (pathname === '/api/backups' && method === 'GET') {
    return ok(res, await wow.listBackups());
  }

  if (pathname.match(/^\/api\/backups\/[^/]+\/restore$/) && method === 'POST') {
    const backupId = decodeURIComponent(pathname.split('/')[3]);
    const target = await wow.resolveAddonPath(settings);
    return ok(res, await wow.restoreBackup(backupId, target.addonPath));
  }

  if (pathname === '/api/profiles' && method === 'GET') {
    return ok(res, { profiles: await profiles.listProfiles() });
  }

  if (pathname === '/api/profiles' && method === 'POST') {
    const body = await readBody(req);
    const profile = await profiles.createProfile({
      name: body.name,
      note: body.note,
      includeFiles: body.includeFiles !== false,
      includeConfig: body.includeConfig !== false,
      includeAllConfig: body.includeAllConfig !== false,
    });
    return ok(res, profile);
  }

  if (pathname === '/api/profiles/preview' && method === 'POST') {
    const body = await readBody(req);
    const profile = await profiles.previewRestore(body.id || body.path);
    return ok(res, profile);
  }

  if (pathname === '/api/profiles/import' && method === 'POST') {
    const body = await readBody(req);
    if (!body.path) throw new AppError('缺少快照文件路径', 'BAD_REQUEST', 400);
    return ok(res, await profiles.importProfile(body.path));
  }

  const profileMatch = pathname.match(/^\/api\/profiles\/([^/]+)(?:\/(restore|export))?$/);
  if (profileMatch) {
    const id = decodeURIComponent(profileMatch[1]);
    const action = profileMatch[2];
    if (method === 'GET' && !action) {
      return ok(res, profiles.getProfile(id));
    }
    if (method === 'DELETE' && !action) {
      return ok(res, await profiles.deleteProfile(id));
    }
    if (method === 'POST' && action === 'export') {
      const body = await readBody(req);
      if (!body.path) throw new AppError('缺少导出位置', 'BAD_REQUEST', 400);
      return ok(res, await profiles.exportProfile(id, body.path));
    }
    if (method === 'POST' && action === 'restore') {
      const body = await readBody(req);
      return ok(
        res,
        tasks.startProfileRestore({
          profileId: id,
          options: {
            overwrite: Boolean(body.overwrite),
            restoreConfig: body.restoreConfig !== false,
            addons: body.addons,
          },
        }),
      );
    }
  }

  if (pathname === '/api/dialog/folder' && method === 'POST') {
    const body = await readBody(req);
    return ok(
      res,
      await dialogs.pickFolder({
        title: String(body.title || '选择文件夹').slice(0, 80),
        defaultPath: String(body.defaultPath || ''),
      }),
    );
  }

  if (pathname === '/api/dialog/file' && method === 'POST') {
    const body = await readBody(req);
    return ok(
      res,
      await dialogs.pickFile({
        title: String(body.title || '选择文件').slice(0, 80),
        defaultPath: String(body.defaultPath || ''),
      }),
    );
  }

  if (pathname === '/api/dialog/save' && method === 'POST') {
    const body = await readBody(req);
    return ok(
      res,
      await dialogs.pickSavePath({
        title: String(body.title || '保存文件').slice(0, 80),
        defaultName: String(body.defaultName || 'profile.wowpack'),
        defaultPath: String(body.defaultPath || ''),
      }),
    );
  }

  if (pathname === '/api/settings' && method === 'GET') {
    return ok(res, store.publicSettings());
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readBody(req);
    const patch = {};
    for (const key of [
      'wowRoot',
      'flavor',
      'addonPath',
      'wclboxVersion',
      'browseVersion',
      'sort',
      'autoCheckUpdates',
      'backupBeforeUpdate',
      'backupLimit',
      'maxDownloads',
      'profileIncludeFiles',
      'profileIncludeConfig',
      'uiScale',
    ]) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.sources && typeof body.sources === 'object') {
      patch.sources = {
        wclbox: body.sources.wclbox !== false,
        curseforge: body.sources.curseforge === true,
        tukui: body.sources.tukui !== false,
        wowinterface: body.sources.wowinterface === true,
        github: body.sources.github === true,
      };
    }
    if (typeof body.curseforgeApiKey === 'string' && body.curseforgeApiKey.trim()) {
      patch.curseforgeApiKey = body.curseforgeApiKey.trim();
    }
    if (body.clearCurseforgeKey) patch.curseforgeApiKey = '';
    if (patch.flavor && FLAVORS[patch.flavor] && body.wclboxVersion === undefined) {
      patch.wclboxVersion = FLAVORS[patch.flavor].wclbox;
    }
    if (patch.addonPath) {
      const normalized = validateAddonPath(patch.addonPath);
      patch.addonPath = normalized;
      if (!patch.wowRoot) patch.wowRoot = rootFromAddonPath(normalized);
    }
    if (patch.wowRoot) {
      patch.wowRoot = path.resolve(String(patch.wowRoot));
    }
    const saved = store.saveSettings(patch);
    clearCaches();
    return ok(res, {
      ...store.publicSettings(),
      target: await wow.resolveAddonPath(saved),
    });
  }

  if (pathname === '/api/detect' && method === 'POST') {
    const installations = await detectCached(true);
    const { target } = await buildClientPayload(settings);
    return ok(res, { installations, clients: flattenClients(installations, target), target });
  }

  if (pathname === '/api/providers/test' && method === 'POST') {
    const body = await readBody(req);
    return ok(res, await providers.test(body.source, settings));
  }

  if (pathname === '/api/reveal' && method === 'POST') {
    const body = await readBody(req);
    const target = path.resolve(String(body.path || ''));
    const allowed = [DATA_DIR, BACKUP_DIR, PROFILE_DIR, settings.wowRoot, settings.addonPath]
      .filter(Boolean)
      .map((entry) => path.resolve(entry));
    const isAllowed = allowed.some(
      (root) => target.toLowerCase() === root.toLowerCase() || isSubPath(root, target),
    );
    if (!isAllowed) throw new AppError('该路径不在允许打开的范围内', 'FORBIDDEN_PATH', 403);
    return ok(res, await wow.revealPath(target));
  }

  throw new AppError('接口不存在', 'NOT_FOUND', 404);
}

async function serveStatic(req, res, pathname) {
  let target = pathname === '/' ? '/index.html' : pathname;
  target = decodeURIComponent(target);
  let root = RENDERER_DIR;
  if (target.startsWith('/assets/')) {
    root = ASSETS_DIR;
    target = target.slice('/assets'.length);
  }
  const resolved = path.resolve(root, `.${target}`);
  if (!isSubPath(root, resolved) && path.resolve(root) !== path.dirname(resolved)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ['.html', '.js', '.css'].includes(ext)
      ? 'no-cache'
      : 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(resolved).pipe(res);
}

function safeSecurityHeaders(res) {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
}

function createServer() {
  return http.createServer(async (req, res) => {
    safeSecurityHeaders(res);
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (error) {
      if (!res.headersSent) fail(res, error);
      else res.end();
    }
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function startServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const preferred = Number(options.port ?? process.env.PORT ?? 17321);
  const server = createServer();
  let port = preferred;
  let lastError = null;
  const attempts = preferred === 0 ? 1 : 12;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      port = await listen(server, port, host);
      return { server, port, url: `http://${host}:${port}` };
    } catch (error) {
      lastError = error;
      if (error.code !== 'EADDRINUSE') throw error;
      port = (port || 17321) + 1;
    }
  }
  throw new AppError(`无法启动本地服务：${lastError?.message || '端口被占用'}`, 'SERVER_FAILED', 500);
}

module.exports = { startServer, createServer };
