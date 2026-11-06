'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const {
  APP_VERSION,
  PROFILE_DIR,
  TMP_DIR,
  ensureDirs,
  FLAVORS,
} = require('./config');
const { AppError } = require('./lib/errors');
const store = require('./lib/store');
const wow = require('./wow');
const wtf = require('./lib/wtf');
const { groupInstalledAddons } = require('./lib/group');
const { pathExistsSync, safeFileName, timestampSlug, uid, compareVersions } = require('./lib/utils');

const FORMAT = 'wow-addon-butler-profile';
const FORMAT_VERSION = 1;
const PROVIDER_IDS = new Set(['wclbox', 'curseforge', 'tukui', 'wowinterface', 'github']);

function profileIdFor(fileName) {
  return path.basename(String(fileName || '')).replace(/\.wowpack$/i, '');
}

function profilePathFor(id) {
  const clean = path.basename(String(id || '')).replace(/\.wowpack$/i, '');
  if (!clean || clean.startsWith('.')) throw new AppError('无效的快照 ID', 'BAD_PROFILE_ID', 400);
  return path.join(PROFILE_DIR, `${clean}.wowpack`);
}

function readManifestFromZip(zip) {
  const entry = zip.getEntry('manifest.json');
  if (!entry) throw new AppError('这不是一个有效的配置快照文件（缺少 manifest.json）', 'BAD_PROFILE', 400);
  let manifest = null;
  try {
    manifest = JSON.parse(entry.getData().toString('utf8'));
  } catch {
    throw new AppError('快照清单损坏，无法读取', 'BAD_PROFILE', 400);
  }
  if (manifest?.format !== FORMAT) {
    throw new AppError('不是魔兽插件管家的配置快照', 'BAD_PROFILE', 400);
  }
  return manifest;
}

function readManifestFile(filePath) {
  if (!pathExistsSync(filePath)) throw new AppError('快照文件不存在', 'NOT_FOUND', 404);
  const zip = new AdmZip(filePath);
  return { zip, manifest: readManifestFromZip(zip) };
}

function profileSummary(id, filePath, manifest, size) {
  return {
    id,
    fileName: path.basename(filePath),
    name: manifest.name || '未命名快照',
    note: manifest.note || '',
    createdAt: manifest.createdAt || '',
    appVersion: manifest.appVersion || '',
    client: manifest.client || null,
    stats: manifest.stats || {},
    includes: manifest.includes || {},
    size,
  };
}

async function listProfiles() {
  ensureDirs();
  const entries = await fsp.readdir(PROFILE_DIR, { withFileTypes: true }).catch(() => []);
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.wowpack$/i.test(entry.name)) continue;
    const filePath = path.join(PROFILE_DIR, entry.name);
    try {
      const stat = await fsp.stat(filePath);
      const { manifest } = readManifestFile(filePath);
      profiles.push(profileSummary(profileIdFor(entry.name), filePath, manifest, stat.size));
    } catch {
      // Ignore broken snapshots but keep them on disk.
    }
  }
  return profiles.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function folderIsEnabled(addonPath, folder) {
  return (
    pathExistsSync(path.join(addonPath, folder)) ||
    pathExistsSync(path.join(addonPath, `${folder}.disabled`))
  );
}

async function createProfile(options = {}) {
  ensureDirs();
  const settings = store.loadSettings();
  const target = await wow.resolveAddonPath(settings);
  if (!target.addonPath) {
    throw new AppError('还没有选择魔兽世界插件目录，无法保存快照', 'NO_ADDON_PATH', 400);
  }
  const scan = await wow.scanAddons(target.addonPath, target.folder, { force: true });
  const groups = groupInstalledAddons(scan.addons).filter(
    (group) => group.folders.length && group.folders.some((folder) => folderIsEnabled(target.addonPath, folder)),
  );
  if (!groups.length) {
    throw new AppError('当前客户端还没有已安装插件，先安装几个再保存快照吧', 'NO_ADDONS', 400);
  }
  const includeFiles = options.includeFiles !== false;
  const includeConfig = options.includeConfig !== false;
  const includeAllConfig = options.includeAllConfig !== false;
  const now = new Date();
  const clientLabel = FLAVORS[target.flavor]?.label || target.folder || '魔兽世界';
  const name =
    String(options.name || '').trim() ||
    `${clientLabel}${target.flavor ? ` · ${new Date().toLocaleDateString('zh-CN')}` : ''}`;
  const packageZip = new AdmZip();
  const addonEntries = [];
  const rawAddons = [];

  for (const group of groups) {
    const primary = group.primary || {};
    const folders = group.folders.filter((folder) => folderIsEnabled(target.addonPath, folder));
    if (!folders.length) continue;
    const inner = new AdmZip();
    const embeddedFolders = [];
    const folderStates = [];
    for (const folder of folders) {
      const enabledPath = path.join(target.addonPath, folder);
      const disabledPath = path.join(target.addonPath, `${folder}.disabled`);
      const actual = pathExistsSync(enabledPath) ? enabledPath : disabledPath;
      if (!pathExistsSync(actual)) continue;
      inner.addLocalFolder(actual, folder, (filename) => !/\.DS_Store$/i.test(filename));
      embeddedFolders.push(folder);
      folderStates.push({ folder, enabled: pathExistsSync(enabledPath) });
      rawAddons.push(
        ...scan.addons.filter((addon) => addon.baseFolder.toLowerCase() === folder.toLowerCase()),
      );
    }
    if (!embeddedFolders.length) continue;
    const fileName = `${String(addonEntries.length + 1).padStart(2, '0')}-${safeFileName(
      group.baseFolder,
      'addon',
    )}.zip`;
    const buffer = inner.toBuffer();
    if (includeFiles) packageZip.addFile(`addons/${fileName}`, buffer);
    addonEntries.push({
      key: group.id,
      name: group.name,
      folders: embeddedFolders,
      folderStates,
      version: group.version || '',
      author: group.author || '',
      enabled: group.enabled,
      mixed: Boolean(group.mixed),
      library: Boolean(group.isLibrary),
      language: group.language || '',
      source: group.source || '',
      remoteId: group.remoteId || '',
      remoteName: group.managed?.remoteName || group.name,
      remoteVersion: group.managed?.remoteVersion || '',
      pinned: Boolean(group.managed?.pinned),
      savedVariables: primary.savedVariables || [],
      savedVariablesPerCharacter: primary.savedVariablesPerCharacter || [],
      tocFile: primary.tocFile || '',
      interface: primary.interface || 0,
      fileName,
      embedded: Boolean(includeFiles),
      sourceBytes: buffer.length,
    });
  }

  let config = { included: false, all: false, files: [], totalBytes: 0 };
  if (includeConfig) {
    const saved = await wtf.listSavedVariables(target.addonPath, rawAddons, {
      includeAll: includeAllConfig,
    });
    for (const file of saved.files) {
      const absolute = path.join(
        wtf.clientDirFromAddonPath(target.addonPath),
        file.relativePath,
      );
      try {
        const buffer = await fsp.readFile(absolute);
        packageZip.addFile(`wtf/${file.relativePath}`, buffer);
        config.files.push({ ...file, absolutePath: undefined });
        config.totalBytes += buffer.length;
      } catch {
        // A file may be written while the game is saving; skip it.
      }
    }
    config.included = config.files.length > 0;
    config.all = includeAllConfig;
  }

  const id = `${timestampSlug()}-${uid().slice(-5)}`;
  const createdAt = now.toISOString();
  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    id,
    name,
    note: String(options.note || '').slice(0, 500),
    createdAt,
    appVersion: APP_VERSION,
    platform: process.platform,
    client: {
      flavor: target.flavor,
      label: clientLabel,
      folder: target.folder,
      version: target.version || '',
      addonPath: target.addonPath,
      wowRoot: target.root || '',
    },
    addons: addonEntries,
    config,
    includes: { addonFiles: includeFiles, config: config.included },
    stats: {
      addons: addonEntries.length,
      folders: addonEntries.reduce((sum, entry) => sum + entry.folders.length, 0),
      addonBytes: addonEntries.reduce((sum, entry) => sum + entry.sourceBytes, 0),
      configFiles: config.files.length,
      configBytes: config.totalBytes,
    },
  };
  packageZip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  packageZip.addFile(
    'README.txt',
    Buffer.from(
      [
        '魔兽插件管家 · 配置快照',
        '',
        `名称：${name}`,
        `创建时间：${createdAt}`,
        `客户端：${clientLabel}${manifest.client.version ? ` ${manifest.client.version}` : ''}`,
        `插件：${manifest.stats.addons} 个 / ${manifest.stats.folders} 个文件夹`,
        `角色配置：${config.files.length} 个 SavedVariables 文件`,
        '',
        '在「魔兽插件管家 → 备份与迁移」中导入此文件即可在新环境快速配齐插件。',
        '快照可能包含插件配置和角色数据，分享给他人前请确认内容。',
      ].join('\n'),
      'utf8',
    ),
  );

  const buffer = packageZip.toBuffer();
  const fileName = `${id}.wowpack`;
  const finalPath = path.join(PROFILE_DIR, fileName);
  await fsp.writeFile(finalPath, buffer);
  store.saveSettings({ lastProfileAt: createdAt });
  return profileSummary(id, finalPath, manifest, buffer.length);
}

function getProfile(id) {
  const filePath = profilePathFor(id);
  const stat = fs.statSync(filePath);
  const { manifest } = readManifestFile(filePath);
  return {
    ...profileSummary(profileIdFor(filePath), filePath, manifest, stat.size),
    manifest,
  };
}

function getProfileByPath(filePath) {
  const { manifest } = readManifestFile(filePath);
  const stat = fs.statSync(filePath);
  return {
    ...profileSummary(profileIdFor(filePath), filePath, manifest, stat.size),
    manifest,
  };
}

async function previewRestore(profileIdOrPath, options = {}) {
  const settings = store.loadSettings();
  const target = options.addonPath
    ? { addonPath: options.addonPath, folder: options.folder || '' }
    : await wow.resolveAddonPath(settings);
  const filePath = profileIdOrPath.includes('/')
    ? path.resolve(profileIdOrPath)
    : profilePathFor(profileIdOrPath);
  const { zip, manifest } = readManifestFile(filePath);
  const scan = target.addonPath
    ? await wow.scanAddons(target.addonPath, target.folder, { force: true })
    : { addons: [] };
  const byFolder = new Map(scan.addons.map((addon) => [addon.baseFolder.toLowerCase(), addon]));
  const entries = (manifest.addons || []).map((entry) => {
    const present = (entry.folders || [])
      .map((folder) => byFolder.get(String(folder).toLowerCase()))
      .filter(Boolean);
    const embedded = Boolean(entry.fileName && zip.getEntry(`addons/${entry.fileName}`));
    const status =
      present.length === 0 ? 'missing' : present.length === entry.folders.length ? 'installed' : 'partial';
    let versionState = '';
    if (present.length) {
      const installedVersion = present[0].version || '';
      const comparison = compareVersions(entry.version || '', installedVersion);
      versionState =
        comparison === null
          ? installedVersion && entry.version && installedVersion !== entry.version
            ? 'different'
            : 'same'
          : comparison > 0
            ? 'older'
            : comparison < 0
              ? 'newer'
              : 'same';
    }
    return {
      ...entry,
      status,
      installedVersion: present[0]?.version || '',
      versionState,
      canInstall: embedded || Boolean(entry.source && entry.remoteId && PROVIDER_IDS.has(entry.source)),
      source: entry.source || '',
    };
  });
  const missing = entries.filter((entry) => entry.status !== 'installed');
  const configFiles = manifest.config?.files || [];
  const warnings = [];
  if (!target.addonPath) warnings.push('还没有选择插件目录，恢复前需要先选择客户端。');
  if (settings.wowRoot && manifest.client?.wowRoot && manifest.client.wowRoot !== settings.wowRoot) {
    warnings.push('快照来自另一个游戏安装位置，插件会安装到当前客户端。');
  }
  if (manifest.client?.folder && target.folder && manifest.client.folder !== target.folder) {
    warnings.push(
      `快照来自 ${manifest.client.label || manifest.client.folder}（${manifest.client.folder}），当前是 ${
        target.folder
      }，请确认版本是否兼容。`,
    );
  }
  return {
    ...profileSummary(profileIdFor(filePath), filePath, manifest, fs.statSync(filePath).size),
    manifest,
    entries,
    target,
    summary: {
      total: entries.length,
      installed: entries.filter((entry) => entry.status === 'installed').length,
      missing: missing.length,
      restorable: entries.filter((entry) => entry.status !== 'installed' && entry.canInstall).length,
      configFiles: configFiles.length,
      configBytes: manifest.config?.totalBytes || 0,
    },
    warnings,
  };
}

async function deleteProfile(id) {
  const filePath = profilePathFor(id);
  await fsp.rm(filePath, { force: true });
  return { id };
}

async function exportProfile(id, destination) {
  const filePath = profilePathFor(id);
  if (!pathExistsSync(filePath)) throw new AppError('快照不存在', 'NOT_FOUND', 404);
  const source = fs.statSync(filePath);
  let targetPath = path.resolve(String(destination || ''));
  if (!targetPath) throw new AppError('没有选择导出位置', 'BAD_PATH', 400);
  if (/\/$/.test(String(destination))) {
    targetPath = path.join(targetPath, path.basename(filePath));
  }
  if (!/\.wowpack$/i.test(targetPath)) targetPath = `${targetPath}.wowpack`;
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.copyFile(filePath, targetPath);
  return { path: targetPath, size: source.size };
}

async function importProfile(sourcePath) {
  ensureDirs();
  const resolved = path.resolve(String(sourcePath || ''));
  if (!pathExistsSync(resolved)) throw new AppError('找不到要导入的快照文件', 'NOT_FOUND', 404);
  const stat = await fsp.stat(resolved);
  if (stat.size > 4 * 1024 * 1024 * 1024) throw new AppError('快照文件过大', 'FILE_TOO_LARGE', 413);
  const { manifest } = readManifestFile(resolved);
  const id = `${timestampSlug()}-${uid().slice(-5)}`;
  const targetPath = path.join(PROFILE_DIR, `${id}.wowpack`);
  await fsp.copyFile(resolved, targetPath);
  return profileSummary(id, targetPath, manifest, stat.size);
}

function embeddedAddonPath(zip, entry, tempDir) {
  const zipEntry = zip.getEntry(`addons/${entry.fileName}`);
  if (!zipEntry) return '';
  const tempPath = path.join(tempDir, safeFileName(entry.fileName, 'addon.zip'));
  fs.writeFileSync(tempPath, zipEntry.getData());
  return tempPath;
}

async function ensureTempDir() {
  ensureDirs();
  const dir = path.join(TMP_DIR, `profile-${uid()}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

module.exports = {
  FORMAT,
  listProfiles,
  createProfile,
  getProfile,
  getProfileByPath,
  previewRestore,
  deleteProfile,
  exportProfile,
  importProfile,
  readManifestFile,
  profilePathFor,
  embeddedAddonPath,
  ensureTempDir,
  profileIdFor,
};
