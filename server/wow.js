'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const AdmZip = require('adm-zip');
const { AppError } = require('./lib/errors');
const {
  normalizeName,
  cleanText,
  isSubPath,
  pathExists,
  pathExistsSync,
  safeFileName,
  timestampSlug,
  uid,
} = require('./lib/utils');
const {
  FLAVORS,
  BACKUP_DIR,
  DATA_DIR,
  ensureDirs,
} = require('./config');
const store = require('./lib/store');
const { detectAddonLanguage, hasChinese } = require('./lib/language');

const execFileAsync = promisify(execFile);
const SCAN_TTL = 12 * 1000;
const scanCache = new Map();

function stripWowColors(text = '') {
  return String(text)
    .replace(/\|c[0-9a-fA-F]{8}/g, '')
    .replace(/\|r/g, '')
    .replace(/\|T[^|]*\|t/g, '')
    .replace(/\|A[^|]*\|a/g, '')
    .trim();
}

function decodeToc(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.slice(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const byte = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = byte;
    }
    return swapped.slice(2).toString('utf16le');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.slice(3).toString('utf8');
  }
  return buffer.toString('utf8');
}

function splitList(value) {
  return String(value || '')
    .split(/[,，]/)
    .map((part) => cleanText(part))
    .filter(Boolean);
}

function parseToc(content, fileName = '') {
  const meta = {};
  const interfaces = [];
  const dependencies = [];
  const optionalDeps = [];
  const loadWith = [];
  const lines = String(content || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('##')) continue;
    const body = trimmed.replace(/^##\s*/, '');
    const colon = body.indexOf(':');
    if (colon < 0) continue;
    const key = body.slice(0, colon).trim();
    const rawValue = body.slice(colon + 1).trim();
    if (!key) continue;
    if (key.toLowerCase() === 'interface') {
      for (const part of splitList(rawValue)) {
        const numeric = Number(String(part).replace(/\D/g, ''));
        if (numeric) interfaces.push(numeric);
      }
      continue;
    }
    if (/^dependenc/i.test(key) || /^requireddeps$/i.test(key)) {
      dependencies.push(...splitList(rawValue));
      continue;
    }
    if (/^optionaldeps$/i.test(key)) {
      optionalDeps.push(...splitList(rawValue));
      continue;
    }
    if (/^loadwith$/i.test(key)) {
      loadWith.push(...splitList(rawValue));
      continue;
    }
    meta[key] = rawValue;
    meta[key.toLowerCase()] = rawValue;
  }
  const rawTitle = meta['Title-zhCN'] || meta['Title-zhTW'] || meta.Title || path.basename(fileName, '.toc');
  const title = stripWowColors(rawTitle);
  let version = stripWowColors(meta.Version || meta.version || '')
    .replace(/^#+\s*/, '')
    .trim();
  if (/^@.+@$/.test(version)) version = '';
  const rawNotes = meta['Notes-zhCN'] || meta['Notes-zhTW'] || meta.Notes || meta.notes || '';
  const notes = stripWowColors(rawNotes);
  return {
    meta,
    title,
    version,
    author: stripWowColors(meta.Author || meta.author || ''),
    notes,
    savedVariables: splitList(meta.SavedVariables || ''),
    savedVariablesPerCharacter: splitList(meta.SavedVariablesPerCharacter || ''),
    dependencies,
    optionalDeps,
    loadWith,
    interfaces,
    interface: interfaces[0] || 0,
    category: stripWowColors(meta.Category || ''),
    group: stripWowColors(meta.Group || meta.group || ''),
    iconTexture: stripWowColors(meta.IconTexture || ''),
    curseProjectId: stripWowColors(meta['X-Curse-Project-ID'] || ''),
    wowInterfaceId: stripWowColors(meta['X-WoWI-ID'] || ''),
    wagoId: stripWowColors(meta['X-Wago-ID'] || ''),
    tukuiProjectId: stripWowColors(meta['X-Tukui-Project-ID'] || meta['X-Tukui-Project'] || ''),
    loadOnDemand: /^1$/.test(cleanText(meta.LoadOnDemand || '')),
    allowLoadGameType: stripWowColors(meta.AllowLoadGameType || ''),
  };
}

function tocSuffixScore(fileName, folderName, flavorFolder) {
  const base = path.basename(fileName, '.toc').toLowerCase();
  const folder = folderName.toLowerCase();
  let score = 0;
  if (base === folder) score += 100;
  if (base.includes(folder)) score += 20;
  const suffix = base.slice(base.lastIndexOf('_') + 1);
  const expected = {
    _retail_: ['mainline', 'retail'],
    _classic_: ['cata', 'mists', 'wrath', 'tbc', 'classic', 'titan'],
    _classic_era_: ['vanilla', 'classic', 'era'],
    _classic_titan_: ['titan', 'classic'],
    _anniversary_: ['vanilla', 'classic', 'era'],
  }[flavorFolder] || [];
  if (expected.includes(suffix)) score += 50;
  if (suffix === 'mainline' && flavorFolder !== '_retail_') score -= 20;
  if (suffix === 'vanilla' && flavorFolder !== '_classic_era_') score -= 10;
  return score;
}

function chooseToc(files, folderName, flavorFolder) {
  const sorted = files
    .slice()
    .sort(
      (a, b) =>
        tocSuffixScore(b, folderName, flavorFolder) - tocSuffixScore(a, folderName, flavorFolder),
    );
  return sorted[0] || '';
}

async function listTocFiles(folderPath) {
  try {
    const entries = await fsp.readdir(folderPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.toc$/i.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function directorySize(folderPath, maxFiles = 12000) {
  let total = 0;
  let count = 0;
  async function walk(dir) {
    if (count > maxFiles) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        count += 1;
        try {
          const stat = await fsp.stat(full);
          total += stat.size;
        } catch {
          // ignore locked or transient files
        }
      }
      if (count > maxFiles) return;
    }
  }
  await walk(folderPath);
  return total;
}

async function readAddonFolder(folderPath, actualName, flavorFolder) {
  const baseFolder = actualName.replace(/\.disabled$/i, '');
  const enabled = !/\.disabled$/i.test(actualName);
  const tocFiles = await listTocFiles(folderPath);
  if (!tocFiles.length) return null;
  const chosen = chooseToc(tocFiles, baseFolder, flavorFolder);
  let raw = '';
  let toc = parseToc('', chosen);
  try {
    raw = decodeToc(await fsp.readFile(path.join(folderPath, chosen)));
    toc = parseToc(raw, chosen);
  } catch {
    return null;
  }
  let stat = null;
  try {
    stat = await fsp.stat(path.join(folderPath, chosen));
  } catch {
    // ignore
  }
  const managed = store.packageForFolder(baseFolder);
  const title = toc.title || baseFolder;
  const name = stripWowColors(title) || baseFolder;
  const language = await detectAddonLanguage(folderPath, toc);
  return {
    folder: actualName,
    baseFolder,
    path: folderPath,
    enabled,
    name,
    title,
    version: toc.version || managed?.installedVersion || '',
    author: toc.author || '',
    notes: toc.notes || '',
    language: language.code,
    languageLabel:
      language.code === 'zh' ? '中文' : language.code === 'en' ? '无中文' : '待检测',
    languageEvidence: language.evidence || '',
    languageLowConfidence: Boolean(language.lowConfidence),
    group: toc.group || '',
    tocFile: chosen,
    tocFiles,
    interface: toc.interface,
    interfaces: toc.interfaces,
    category: toc.category || '',
    dependencies: toc.dependencies,
    optionalDeps: toc.optionalDeps,
    loadWith: toc.loadWith,
    loadOnDemand: toc.loadOnDemand,
    savedVariables: toc.savedVariables,
    curseProjectId: toc.curseProjectId,
    wowInterfaceId: toc.wowInterfaceId,
    wagoId: toc.wagoId,
    tukuiProjectId: toc.tukuiProjectId,
    modifiedAt: stat ? stat.mtime.toISOString() : '',
    isLibrary:
      /^(lib|ace|callbackhandler|libstub|!!!|!lib)/i.test(baseFolder) ||
      (!toc.author && /^lib/i.test(baseFolder)),
    managed: managed
      ? {
          packageId: managed.id,
          source: managed.source,
          remoteId: managed.remoteId,
          remoteName: managed.remoteName,
          remoteVersion: managed.remoteVersion,
          pinned: Boolean(managed.pinned),
          installedAt: managed.installedAt,
        }
      : null,
    source: managed?.source || (toc.curseProjectId ? 'curseforge' : toc.wowInterfaceId ? 'wowinterface' : ''),
    remoteId: managed?.remoteId || toc.curseProjectId || toc.wowInterfaceId || '',
    warnings: toc.version ? [] : ['TOC 中没有写入版本号'],
  };
}

async function scanAddons(addonPath, flavorFolder = '_classic_', options = {}) {
  const resolved = path.resolve(addonPath || '');
  if (!resolved) throw new AppError('尚未设置插件目录', 'NO_ADDON_PATH', 400);
  const cacheKey = `${resolved}|${flavorFolder}`;
  const hit = scanCache.get(cacheKey);
  if (!options.force && hit && hit.expires > Date.now()) return hit.value;
  if (!pathExistsSync(resolved)) {
    return {
      addonPath: resolved,
      exists: false,
      addons: [],
      stats: { total: 0, enabled: 0, disabled: 0, libraries: 0 },
      scannedAt: new Date().toISOString(),
    };
  }
  let entries = [];
  try {
    entries = await fsp.readdir(resolved, { withFileTypes: true });
  } catch (error) {
    throw new AppError(`无法读取插件目录：${error.message}`, 'READ_ADDONS_FAILED', 400);
  }
  const addons = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (/^wow-butler-staging-/i.test(entry.name)) continue;
    const folderPath = path.join(resolved, entry.name);
    const addon = await readAddonFolder(folderPath, entry.name, flavorFolder);
    if (addon) addons.push(addon);
  }
  addons.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const value = {
    addonPath: resolved,
    exists: true,
    addons,
    stats: {
      total: addons.length,
      enabled: addons.filter((addon) => addon.enabled).length,
      disabled: addons.filter((addon) => !addon.enabled).length,
      libraries: addons.filter((addon) => addon.isLibrary).length,
    },
    scannedAt: new Date().toISOString(),
  };
  scanCache.set(cacheKey, { value, expires: Date.now() + SCAN_TTL });
  return value;
}

function invalidateScan(addonPath) {
  if (addonPath) {
    const root = path.resolve(addonPath).toLowerCase();
    for (const key of scanCache.keys()) {
      const cachedPath = key.split('|')[0].toLowerCase();
      if (cachedPath === root || cachedPath.startsWith(`${root}${path.sep}`)) {
        scanCache.delete(key);
      }
    }
  } else {
    scanCache.clear();
  }
}

function parseBuildInfoRows(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (!lines.length) return [];
  const header = lines[0].split('|').map((part) => part.split('!')[0]);
  return lines.slice(1).map((line) => {
    const values = line.split('|');
    const row = {};
    header.forEach((key, index) => {
      row[key] = values[index] ?? '';
    });
    return row;
  });
}

const FOLDER_PRODUCT = {
  _retail_: 'wow',
  _classic_: 'wow_classic',
  _classic_era_: 'wow_classic_era',
  _forever_: 'wowf',
  _classic_beta_: 'wowf',
  _anniversary_: 'wow_anniversary',
};

async function readBuildInfo(root, folder) {
  // Some clients (for example WoW Forever on macOS) keep .build.info at the
  // install root instead of inside the flavor folder. Try the folder first,
  // then fall back to the product row in the root file.
  const localFile = path.join(root, folder, '.build.info');
  if (pathExistsSync(localFile)) {
    try {
      const raw = await fsp.readFile(localFile, 'utf8');
      const values = {};
      for (const part of raw.split('|')) {
        const [key, , value] = part.split('!');
        if (key) values[key] = value;
      }
      if (values.Version || values.Branch) return values;
    } catch {
      // ignore and try the root file
    }
  }
  const rootFile = path.join(root, '.build.info');
  if (!pathExistsSync(rootFile)) return {};
  try {
    const rows = parseBuildInfoRows(await fsp.readFile(rootFile, 'utf8'));
    if (!rows.length) return {};
    const product = FOLDER_PRODUCT[folder] || '';
    const match =
      (product && rows.find((row) => String(row.Product || '').toLowerCase() === product)) ||
      (rows.length === 1 ? rows[0] : null);
    if (!match) return {};
    return {
      Branch: match.Branch || '',
      Version: match.Version || '',
      Product: match.Product || '',
      BuildKey: match['Build Key'] || '',
    };
  } catch {
    return {};
  }
}

function shortGameVersion(version) {
  const text = String(version || '').trim();
  if (!text) return '';
  const parts = text.split('.');
  if (parts.length <= 2) return text;
  return `${parts[0]}.${parts[1]}`;
}

async function readFlavorInfo(root, folder) {
  const file = path.join(root, folder, '.flavor.info');
  if (!pathExistsSync(file)) return '';
  try {
    return String(await fsp.readFile(file, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function detectFlavors(root) {
  const flavors = [];
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return flavors;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('_')) continue;
    const addonPath = path.join(root, entry.name, 'Interface', 'AddOns');
    const markers = [
      'Interface',
      'WTF',
      'Data',
      '.flavor.info',
      '.build.info',
      'World of Warcraft.app',
      'World of Warcraft Launcher.app',
    ];
    const addonExists = pathExistsSync(addonPath);
    const hasClient = addonExists || markers.some((marker) => pathExistsSync(path.join(root, entry.name, marker)));
    if (!hasClient) continue;
    const build = await readBuildInfo(root, entry.name);
    const flavorInfo = await readFlavorInfo(root, entry.name);
    let profile = profileForFolder(entry.name);
    if (/wowf/i.test(flavorInfo)) {
      profile = 'unlimited';
    }
    if (entry.name === '_classic_beta_') {
      profile = 'unlimited';
    }
    if (entry.name === '_classic_') {
      const branch = `${build.Branch || ''} ${build.Version || ''}`.toLowerCase();
      const product = String(build.Product || '').toLowerCase();
      if (/titan|时光/.test(branch)) profile = 'titan';
      else if (/mists|熊猫/.test(branch)) profile = 'mists';
      else if (/tbc|burning/.test(branch)) profile = 'tbc';
      else if (product === 'wow_classic') profile = 'titan';
    }
    const flavor = FLAVORS[profile] || {
      key: 'custom',
      label: entry.name.replace(/^_|_$/g, ''),
      folder: entry.name,
    };
    let count = 0;
    if (addonExists) {
      try {
        const dirs = await fsp.readdir(addonPath, { withFileTypes: true });
        count = dirs.filter((dir) => dir.isDirectory() && !dir.name.startsWith('.')).length;
      } catch {
        count = 0;
      }
    }
    const version = String(build.Version || '');
    flavors.push({
      key: profile,
      folder: entry.name,
      label: entry.name === '_classic_beta_' ? '无限 · 测试服' : flavor.label || entry.name,
      hint: flavor.hint || '',
      addonPath,
      addonPathExists: addonExists,
      exists: addonExists,
      build,
      version,
      versionShort: shortGameVersion(version),
      addonCount: count,
      profile,
    });
  }
  return flavors;
}

function profileForFolder(folderName) {
  if (folderName === '_forever_' || folderName === '_classic_beta_') return 'unlimited';
  if (folderName === '_anniversary_') return 'anniversary';
  const key = Object.keys(FLAVORS).find(
    (flavorKey) => FLAVORS[flavorKey].folder === folderName && flavorKey !== 'custom',
  );
  return key || 'custom';
}

function readBattleNetRoots() {
  const roots = [];
  try {
    const configPath = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Battle.net',
      'Battle.net.config',
    );
    const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    const installPath = data?.Client?.Install?.DefaultInstallPath;
    if (installPath) {
      roots.push(path.join(installPath, 'World of Warcraft'));
    }
  } catch {
    // Battle.net is optional
  }
  return roots;
}

function candidateRoots() {
  if (process.env.WOW_BUTLER_GAME_ROOT) {
    const override = path.resolve(process.env.WOW_BUTLER_GAME_ROOT);
    if (process.env.WOW_BUTLER_ONLY_GAME_ROOT === '1') return [override];
  }
  if (process.platform === 'darwin') {
    const home = os.homedir();
    const roots = [
      process.env.WOW_BUTLER_GAME_ROOT ? path.resolve(process.env.WOW_BUTLER_GAME_ROOT) : '',
      '/Applications/World of Warcraft',
      path.join(home, 'Applications', 'World of Warcraft'),
      path.join(home, 'Games', 'World of Warcraft'),
      path.join(home, 'World of Warcraft'),
      path.join(home, 'Desktop', 'World of Warcraft'),
      ...readBattleNetRoots(),
    ];
    try {
      for (const volume of fs.readdirSync('/Volumes')) {
        roots.push(path.join('/Volumes', volume, 'World of Warcraft'));
      }
    } catch {
      // no mounted volumes
    }
    return Array.from(new Set(roots.filter(Boolean).map((root) => path.normalize(root))));
  }
  const roots = [];
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  for (const base of programFiles) {
    roots.push(path.join(base, 'World of Warcraft'));
    roots.push(path.join(base, 'Battle.net', 'World of Warcraft'));
  }
  for (const drive of ['C:', 'D:', 'E:', 'F:', 'G:']) {
    roots.push(`${drive}\\World of Warcraft`);
    roots.push(`${drive}\\Games\\World of Warcraft`);
    roots.push(`${drive}\\Program Files\\World of Warcraft`);
    roots.push(`${drive}\\Program Files (x86)\\World of Warcraft`);
    roots.push(`${drive}\\暴雪游戏\\World of Warcraft`);
  }
  return Array.from(new Set(roots.map((root) => path.normalize(root))));
}

function registryPaths() {
  if (process.platform !== 'win32') return [];
  if (process.env.WOW_BUTLER_ONLY_GAME_ROOT === '1') return [];
  const queries = [
    ['HKCU\\Software\\Blizzard Entertainment\\World of Warcraft', 'InstallPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\World of Warcraft', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Blizzard Entertainment\\World of Warcraft', 'InstallPath'],
  ];
  return queries.map(([key, value]) => ({ key, value }));
}

async function registryInstallPaths() {
  const results = [];
  for (const query of registryPaths()) {
    try {
      const { stdout } = await execFileAsync('reg.exe', ['query', query.key, '/v', query.value], {
        windowsHide: true,
        timeout: 4000,
      });
      const match = stdout.match(/REG_SZ\s+(.+)\s*$/im);
      if (match) results.push(match[1].trim());
    } catch {
      // registry key not present
    }
  }
  return results;
}

async function detectInstallations() {
  const roots = [];
  for (const candidate of candidateRoots()) {
    let hasFlavorFolder = false;
    try {
      hasFlavorFolder = fs
        .readdirSync(candidate, { withFileTypes: true })
        .some((entry) => entry.isDirectory() && entry.name.startsWith('_'));
    } catch {
      hasFlavorFolder = false;
    }
    if (hasFlavorFolder || pathExistsSync(path.join(candidate, 'Interface'))) {
      roots.push(candidate);
    }
  }
  for (const registryPath of await registryInstallPaths()) {
    const normalized = path.normalize(registryPath.replace(/[\\/]+$/, ''));
    if (pathExistsSync(normalized) && !roots.some((root) => root.toLowerCase() === normalized.toLowerCase())) {
      roots.push(normalized);
    }
  }
  const installations = [];
  for (const root of roots) {
    const flavors = await detectFlavors(root);
    if (flavors.length) {
      installations.push({ root, flavors });
    } else if (pathExistsSync(path.join(root, 'Interface', 'AddOns'))) {
      const folderName = path.basename(root);
      const parent = path.dirname(root);
      const flavorInfo = await readFlavorInfo(parent, folderName);
      const profile = /wowf/i.test(flavorInfo) || folderName === '_forever_' ? 'unlimited' : 'custom';
      const known = FLAVORS[profile] || {};
      installations.push({
        root: parent,
        flavors: [
          {
            key: profile,
            folder: folderName,
            label: profile === 'unlimited' ? '魔兽世界：无限' : `自定义客户端 · ${folderName}`,
            hint: known.hint || '私服 / 特殊客户端',
            addonPath: path.join(root, 'Interface', 'AddOns'),
            profile,
            addonCount: 0,
          },
        ],
      });
    }
  }
  return installations;
}

function flavorForFolderKey(folderName, fallback) {
  if (folderName === '_forever_' || folderName === '_classic_beta_') return 'unlimited';
  if (folderName === '_anniversary_') return 'anniversary';
  const key = Object.keys(FLAVORS).find(
    (flavorKey) => FLAVORS[flavorKey].folder === folderName && flavorKey !== 'custom',
  );
  return key || fallback || 'custom';
}

function buildTarget(addonPath, root, folder, flavor, extra = {}) {
  return {
    addonPath,
    exists: pathExistsSync(addonPath),
    root: root || '',
    folder,
    flavor,
    ...extra,
  };
}

async function resolveAddonPath(settings = {}) {
  if (settings.addonPath) {
    const normalized = path.resolve(settings.addonPath);
    const folder = path.basename(path.dirname(path.dirname(normalized)));
    const clientDir = path.dirname(path.dirname(normalized));
    const clientExists =
      pathExistsSync(normalized) ||
      pathExistsSync(clientDir) ||
      pathExistsSync(path.join(path.dirname(clientDir), folder));
    if (clientExists) {
      const wanted = FLAVORS[settings.flavor];
      const flavor =
        wanted && (wanted.folder === folder || (wanted.folders || []).includes(folder))
          ? settings.flavor
          : flavorForFolderKey(folder, settings.flavor);
      const root = path.dirname(clientDir);
      const build = await readBuildInfo(root, folder);
      return buildTarget(normalized, root, folder, flavor, {
        version: build.Version || '',
        versionShort: shortGameVersion(build.Version || ''),
      });
    }
  }
  const installations = await detectInstallations();
  const pickFlavor = (installation, wantedKey) => {
    const wanted = FLAVORS[wantedKey] || FLAVORS.retail;
    return (
      installation.flavors.find((entry) => entry.key === wantedKey) ||
      installation.flavors.find((entry) => (wanted.folders || [wanted.folder]).includes(entry.folder)) ||
      installation.flavors[0]
    );
  };
  if (settings.wowRoot) {
    const normalizedRoot = path.resolve(settings.wowRoot);
    const installation = installations.find(
      (entry) => entry.root.toLowerCase() === normalizedRoot.toLowerCase(),
    );
    if (installation) {
      const flavor = pickFlavor(installation, settings.flavor);
      return buildTarget(flavor.addonPath, installation.root, flavor.folder, flavor.key, {
        version: flavor.version || '',
      });
    }
  }
  if (installations.length) {
    const installation = installations[0];
    const flavor = pickFlavor(installation, settings.flavor);
    return buildTarget(flavor.addonPath, installation.root, flavor.folder, flavor.key, {
      version: flavor.version || '',
    });
  }
  if (settings.wowRoot) {
    const wanted = FLAVORS[settings.flavor] || FLAVORS.retail;
    const folder = wanted.folder || '';
    const addonPath = folder
      ? path.join(settings.wowRoot, folder, 'Interface', 'AddOns')
      : path.join(settings.wowRoot, 'Interface', 'AddOns');
    return buildTarget(addonPath, path.resolve(settings.wowRoot), folder, settings.flavor || 'custom');
  }
  return {
    addonPath: '',
    exists: false,
    root: '',
    folder: '',
    flavor: settings.flavor || 'retail',
  };
}

async function ensureAddonPath(addonPath) {
  if (!addonPath) throw new AppError('尚未设置插件目录', 'NO_ADDON_PATH', 400);
  const resolved = path.resolve(addonPath);
  if (!/interface[\\/]addons$/i.test(resolved)) {
    throw new AppError('插件目录必须位于 Interface\\AddOns 下', 'BAD_ADDON_PATH', 400);
  }
  await fsp.mkdir(resolved, { recursive: true });
  return resolved;
}

async function setEnabled(addonPath, folder, enabled) {
  const resolved = await ensureAddonPath(addonPath);
  const actual = String(folder || '');
  if (!actual || actual.includes('/') || actual.includes('\\') || actual === '..') {
    throw new AppError('无效的插件文件夹', 'BAD_FOLDER', 400);
  }
  const base = actual.replace(/\.disabled$/i, '');
  const enabledPath = path.join(resolved, base);
  const disabledPath = path.join(resolved, `${base}.disabled`);
  const current = pathExistsSync(path.join(resolved, actual))
    ? path.join(resolved, actual)
    : pathExistsSync(enabledPath)
      ? enabledPath
      : disabledPath;
  if (!pathExistsSync(current)) throw new AppError('插件文件夹不存在', 'NOT_FOUND', 404);
  const target = path.join(resolved, enabled ? base : `${base}.disabled`);
  if (path.resolve(current) === path.resolve(target)) {
    return { folder: path.basename(target), enabled };
  }
  if (pathExistsSync(target)) {
    throw new AppError(`目标文件夹已存在：${path.basename(target)}`, 'TARGET_EXISTS', 409);
  }
  try {
    await fsp.rename(current, target);
  } catch (error) {
    throw new AppError(
      `无法${enabled ? '启用' : '禁用'}插件，游戏可能正在运行：${error.message}`,
      'RENAME_FAILED',
      409,
    );
  }
  invalidateScan(resolved);
  store.addHistory({
    type: enabled ? 'enable' : 'disable',
    name: base,
    folder: base,
  });
  return { folder: path.basename(target), enabled };
}

async function isWowRunning() {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/usr/bin/pgrep', ['-x', 'World of Warcraft'], {
        timeout: 4000,
      });
      if (String(stdout || '').trim()) return true;
    } catch {
      // not running
    }
    try {
      const { stdout } = await execFileAsync(
        '/usr/bin/pgrep',
        ['-fl', 'World of Warcraft.app/Contents/MacOS/World of Warcraft'],
        { timeout: 4000 },
      );
      return String(stdout || '')
        .split(/\r?\n/)
        .some((line) => /World of Warcraft\/Contents\/MacOS\/World of Warcraft$/i.test(line.trim()));
    } catch {
      return false;
    }
  }
  if (process.platform !== 'win32') return false;
  const names = ['Wow.exe', 'WowClassic.exe', 'WowClassicT.exe'];
  for (const name of names) {
    try {
      const { stdout } = await execFileAsync(
        'tasklist.exe',
        ['/FI', `IMAGENAME eq ${name}`, '/NH'],
        { windowsHide: true, timeout: 4000 },
      );
      if (stdout.toLowerCase().includes(name.toLowerCase())) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

async function createBackup(folderPath, metadata = {}, reason = 'manual') {
  ensureDirs();
  const baseName = path.basename(folderPath).replace(/\.disabled$/i, '');
  const dirName = `${timestampSlug()}-${safeFileName(baseName, 'addon')}-${uid().slice(-4)}`;
  const backupPath = path.join(BACKUP_DIR, dirName);
  await fsp.mkdir(backupPath, { recursive: true });
  await fsp.cp(folderPath, path.join(backupPath, path.basename(folderPath)), {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
  const info = {
    id: dirName,
    folder: baseName,
    storedFolder: path.basename(folderPath),
    path: backupPath,
    reason,
    createdAt: new Date().toISOString(),
    metadata,
  };
  await fsp.writeFile(path.join(backupPath, 'backup.json'), JSON.stringify(info, null, 2), 'utf8');
  await pruneBackups();
  return info;
}

async function pruneBackups() {
  ensureDirs();
  const settings = store.loadSettings();
  const limit = Math.max(1, Number(settings.backupLimit) || 8);
  const entries = await fsp.readdir(BACKUP_DIR, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  for (const stale of dirs.slice(limit)) {
    await fsp.rm(path.join(BACKUP_DIR, stale), { recursive: true, force: true }).catch(() => {});
  }
}

async function listBackups() {
  ensureDirs();
  const entries = await fsp.readdir(BACKUP_DIR, { withFileTypes: true }).catch(() => []);
  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const infoPath = path.join(BACKUP_DIR, entry.name, 'backup.json');
    let info = null;
    try {
      info = JSON.parse(await fsp.readFile(infoPath, 'utf8'));
    } catch {
      info = { id: entry.name, createdAt: '', reason: 'unknown', metadata: {} };
    }
    backups.push(info);
  }
  return backups.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function zipEntryName(entry) {
  return String(entry.entryName || '').replace(/\\/g, '/');
}

function validateZipEntries(entries) {
  if (entries.length > 50000) {
    throw new AppError('压缩包文件数量过多，已阻止安装', 'ZIP_TOO_LARGE', 413);
  }
  let total = 0;
  for (const entry of entries) {
    const name = zipEntryName(entry);
    if (!name || name.endsWith('/')) continue;
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
      throw new AppError('压缩包包含不安全的绝对路径，已阻止安装', 'UNSAFE_ZIP', 400);
    }
    const parts = name.split('/');
    if (parts.includes('..') || parts.some((part) => /[:*?"<>|\x00-\x1f]/.test(part))) {
      throw new AppError('压缩包包含不安全或非法的文件路径，已阻止安装', 'UNSAFE_ZIP', 400);
    }
    total += Number(entry.header?.size || 0);
    if (total > 650 * 1024 * 1024) {
      throw new AppError('压缩包解压后体积过大，已阻止安装', 'ZIP_TOO_LARGE', 413);
    }
  }
  return total;
}

function inspectZip(zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  validateZipEntries(entries);
  const candidates = new Map();
  for (const entry of entries) {
    const name = zipEntryName(entry);
    if (!/\.toc$/i.test(name)) continue;
    const parts = name.split('/');
    const tocFile = parts.pop();
    if (!tocFile) continue;
    const parentParts = parts;
    if (!parentParts.length) {
      candidates.set('', {
        prefix: '',
        folder: path.basename(tocFile, '.toc'),
        tocFile,
        depth: 0,
      });
      continue;
    }
    const folder = parentParts[parentParts.length - 1];
    if (parentParts.some((part) => /^(libs?|libraries)$/i.test(part))) continue;
    const prefix = `${parentParts.join('/')}/`;
    if (!candidates.has(prefix)) {
      candidates.set(prefix, {
        prefix,
        folder,
        tocFile,
        depth: parentParts.length,
      });
    }
  }
  let roots = Array.from(candidates.values());
  if (!roots.length) {
    throw new AppError('压缩包里没有找到 .toc 文件，不像是魔兽插件', 'NO_TOC', 400);
  }
  const minDepth = Math.min(...roots.map((root) => root.depth));
  roots = roots.filter((root) => root.depth === minDepth || root.depth === 1);
  if (minDepth > 1) {
    const wrapper = roots[0].prefix.split('/')[0];
    const stripped = roots
      .filter((root) => root.prefix.startsWith(`${wrapper}/`))
      .map((root) => ({
        ...root,
        prefix: root.prefix.slice(wrapper.length + 1),
      }));
    if (stripped.length) {
      return {
        zip,
        entries,
        roots: stripped,
        wrapper: `${wrapper}/`,
        totalSize: validateZipEntries(entries),
      };
    }
  }
  return {
    zip,
    entries,
    roots,
    wrapper: '',
    totalSize: validateZipEntries(entries),
  };
}

function safeFolderName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/^\.+|\.+$/g, '')
    .trim();
}

async function installZip(zipPath, addonPath, meta = {}, options = {}) {
  const settings = store.loadSettings();
  const resolved = await ensureAddonPath(addonPath);
  if (await isWowRunning()) {
    throw new AppError(
      '检测到魔兽世界正在运行，请先完全退出游戏再安装或更新插件',
      'WOW_RUNNING',
      409,
    );
  }
  const inspected = (() => {
    try {
      return inspectZip(zipPath);
    } catch (error) {
      if (/ADM-ZIP|Duplicate entry|No descriptor|invalid zip/i.test(error.message || '')) {
        return null;
      }
      throw error;
    }
  })();
  if (!inspected) {
    return installWithSystemExtractor(zipPath, resolved, meta, options);
  }
  const staging = path.join(resolved, `.wow-butler-staging-${uid()}`);
  await fsp.mkdir(staging, { recursive: true });
  const prepared = [];
  try {
    for (const root of inspected.roots) {
      const folder = safeFolderName(root.folder);
      if (!folder || folder === '.' || folder === '..') {
        throw new AppError('压缩包中的插件文件夹名称无效', 'BAD_ZIP_FOLDER', 400);
      }
      const targetStaging = path.join(staging, folder);
      await fsp.mkdir(targetStaging, { recursive: true });
      const prefix = inspected.wrapper + root.prefix;
      for (const entry of inspected.entries) {
        const name = zipEntryName(entry);
        if (!prefix || !name.startsWith(prefix)) continue;
        if (name.endsWith('/')) continue;
        const relative = name.slice(prefix.length);
        if (!relative || relative.startsWith('/')) continue;
        const destination = path.join(targetStaging, relative);
        if (!isSubPath(targetStaging, destination)) continue;
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        await fsp.writeFile(destination, entry.getData());
      }
      // Verify that this folder really contains a TOC after extraction.
      const tocFiles = await listTocFiles(targetStaging);
      if (!tocFiles.length) {
        throw new AppError(`插件 ${folder} 解压后缺少 TOC 文件`, 'BAD_ADDON', 400);
      }
      prepared.push({ folder, staging: targetStaging });
    }

    const installed = [];
    const backups = [];
    for (const item of prepared) {
      const target = path.join(resolved, item.folder);
      const disabledTarget = path.join(resolved, `${item.folder}.disabled`);
      const existing = pathExistsSync(target)
        ? target
        : pathExistsSync(disabledTarget)
          ? disabledTarget
          : null;
      if (existing) {
        if (settings.backupBeforeUpdate !== false) {
          try {
            backups.push(
              await createBackup(existing, {
                source: meta.source,
                remoteId: meta.remoteId,
                remoteName: meta.remoteName,
                version: meta.remoteVersion,
              }, 'before-install'),
            );
          } catch {
            // A failed backup should not silently destroy the existing addon.
            throw new AppError('备份现有插件失败，已取消安装以保护原文件', 'BACKUP_FAILED', 500);
          }
        }
        const oldPath = `${existing}.wow-butler-old-${uid()}`;
        await fsp.rename(existing, oldPath);
        try {
          await fsp.rename(item.staging, target);
          await fsp.rm(oldPath, { recursive: true, force: true });
        } catch (error) {
          await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
          await fsp.rename(oldPath, existing).catch(() => {});
          throw new AppError(
            `替换插件文件失败，原插件已恢复：${error.message}`,
            'INSTALL_FAILED',
            500,
          );
        }
      } else {
        await fsp.rename(item.staging, target);
      }
      installed.push(item.folder);
    }

    const record = store.recordInstall({
      source: meta.source || 'unknown',
      remoteId: meta.remoteId || 'unknown',
      remoteName: meta.remoteName || meta.name || installed.join(', '),
      remoteVersion: meta.remoteVersion || '',
      folders: installed,
      icon: meta.icon || '',
      url: meta.url || '',
      zipName: meta.zipName || path.basename(zipPath),
    });
    invalidateScan(resolved);
    const scan = await scanAddons(resolved, options.flavorFolder || '', { force: true });
    const installedDetails = scan.addons.filter((addon) =>
      installed.some((folder) => addon.baseFolder.toLowerCase() === folder.toLowerCase()),
    );
    return {
      folders: installed,
      package: record,
      installed: installedDetails,
      backups,
      scan,
    };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractWithSystem(zipPath, destination) {
  try {
    if (process.platform === 'darwin') {
      await execFileAsync('/usr/bin/ditto', ['-x', '-k', zipPath, destination], {
        timeout: 180000,
      });
      return;
    }
    if (process.platform === 'win32') {
      const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(destination)} -Force`,
        ],
        { timeout: 120000, windowsHide: true, encoding: 'utf8' },
      );
      return;
    }
    await execFileAsync('/usr/bin/unzip', ['-o', '-q', zipPath, '-d', destination], {
      timeout: 180000,
    });
  } catch (error) {
    throw new AppError(`ZIP 解压失败：${error.message}`, 'ZIP_EXTRACT_FAILED', 500);
  }
}

async function findExtractedAddonRoots(root) {
  const tocFiles = [];
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && /\.toc$/i.test(entry.name)) {
        tocFiles.push({ dir, file: entry.name, depth });
      } else if (entry.isDirectory()) {
        if (/^(libs?|libraries|locales?|localization|language)$/i.test(entry.name)) continue;
        await walk(full, depth + 1);
      }
    }
  }
  await walk(root, 0);
  if (!tocFiles.length) {
    throw new AppError('压缩包里没有找到 .toc 文件，不像是魔兽插件', 'NO_TOC', 400);
  }
  const minDepth = Math.min(...tocFiles.map((entry) => entry.depth));
  const roots = new Map();
  for (const entry of tocFiles.filter((item) => item.depth === minDepth)) {
    const folder =
      entry.depth === 0
        ? safeFolderName(path.basename(entry.file, '.toc'))
        : safeFolderName(path.basename(entry.dir));
    if (!folder) continue;
    const source = entry.depth === 0 ? root : entry.dir;
    if (!roots.has(source)) roots.set(source, { source, folder });
  }
  return Array.from(roots.values());
}

async function installWithSystemExtractor(zipPath, resolved, meta = {}, options = {}) {
  const settings = store.loadSettings();
  const extractRoot = path.join(DATA_DIR, 'tmp', `wow-butler-extract-${uid()}`);
  const staging = path.join(resolved, `.wow-butler-staging-${uid()}`);
  await fsp.mkdir(extractRoot, { recursive: true });
  await fsp.mkdir(staging, { recursive: true });
  try {
    await extractWithSystem(zipPath, extractRoot);
    const roots = await findExtractedAddonRoots(extractRoot);
    const prepared = [];
    for (const root of roots) {
      const folder = safeFolderName(root.folder);
      if (!folder || folder === '.' || folder === '..') {
        throw new AppError('压缩包中的插件文件夹名称无效', 'BAD_ZIP_FOLDER', 400);
      }
      const targetStaging = path.join(staging, folder);
      await fsp.cp(root.source, targetStaging, { recursive: true, force: true });
      const tocFiles = await listTocFiles(targetStaging);
      if (!tocFiles.length) {
        throw new AppError(`插件 ${folder} 解压后缺少 TOC 文件`, 'BAD_ADDON', 400);
      }
      prepared.push({ folder, staging: targetStaging });
    }

    const installed = [];
    const backups = [];
    for (const item of prepared) {
      const target = path.join(resolved, item.folder);
      const disabledTarget = path.join(resolved, `${item.folder}.disabled`);
      const existing = pathExistsSync(target)
        ? target
        : pathExistsSync(disabledTarget)
          ? disabledTarget
          : null;
      if (existing) {
        if (settings.backupBeforeUpdate !== false) {
          try {
            backups.push(
              await createBackup(
                existing,
                {
                  source: meta.source,
                  remoteId: meta.remoteId,
                  remoteName: meta.remoteName,
                  version: meta.remoteVersion,
                },
                'before-install',
              ),
            );
          } catch {
            throw new AppError('备份现有插件失败，已取消安装以保护原文件', 'BACKUP_FAILED', 500);
          }
        }
        const oldPath = `${existing}.wow-butler-old-${uid()}`;
        await fsp.rename(existing, oldPath);
        try {
          await fsp.rename(item.staging, target);
          await fsp.rm(oldPath, { recursive: true, force: true });
        } catch (error) {
          await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
          await fsp.rename(oldPath, existing).catch(() => {});
          throw new AppError(`替换插件文件失败，原插件已恢复：${error.message}`, 'INSTALL_FAILED', 500);
        }
      } else {
        await fsp.rename(item.staging, target);
      }
      installed.push(item.folder);
    }

    const record = store.recordInstall({
      source: meta.source || 'unknown',
      remoteId: meta.remoteId || 'unknown',
      remoteName: meta.remoteName || meta.name || installed.join(', '),
      remoteVersion: meta.remoteVersion || '',
      folders: installed,
      icon: meta.icon || '',
      url: meta.url || '',
      zipName: meta.zipName || path.basename(zipPath),
    });
    invalidateScan(resolved);
    const scan = await scanAddons(resolved, options.flavorFolder || '', { force: true });
    return {
      folders: installed,
      package: record,
      installed: scan.addons.filter((addon) =>
        installed.some((folder) => addon.baseFolder.toLowerCase() === folder.toLowerCase()),
      ),
      backups,
      scan,
    };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(extractRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function uninstallAddon(addonPath, folder, options = {}) {
  const resolved = await ensureAddonPath(addonPath);
  const actual = path.basename(String(folder || ''));
  const base = actual.replace(/\.disabled$/i, '');
  if (!base || base === '.' || base === '..') {
    throw new AppError('无效的插件文件夹', 'BAD_FOLDER', 400);
  }
  const enabledRoot = path.join(resolved, base);
  const disabledRoot = path.join(resolved, `${base}.disabled`);
  if (!pathExistsSync(enabledRoot) && !pathExistsSync(disabledRoot)) {
    throw new AppError('插件文件夹不存在', 'NOT_FOUND', 404);
  }
  if (await isWowRunning()) {
    throw new AppError('检测到魔兽世界正在运行，请先退出游戏再删除插件', 'WOW_RUNNING', 409);
  }

  const pkg = store.packageForFolder(base);
  const requested = Array.isArray(options.folders)
    ? options.folders.map((name) => path.basename(String(name)))
    : [];
  const wanted = requested.length ? requested : pkg?.folders?.length ? pkg.folders : [base];
  const actualFolders = [];
  for (const name of wanted) {
    const clean = path.basename(String(name || '').replace(/\.disabled$/i, ''));
    if (!clean) continue;
    const enabledPath = path.join(resolved, clean);
    const disabledPath = path.join(resolved, `${clean}.disabled`);
    if (pathExistsSync(enabledPath) && !actualFolders.includes(clean)) actualFolders.push(clean);
    if (
      pathExistsSync(disabledPath) &&
      !actualFolders.includes(`${clean}.disabled`)
    ) {
      actualFolders.push(`${clean}.disabled`);
    }
  }
  // Keep the folder that was actually clicked even if the group manifest is
  // stale or names differ slightly.
  if (!actualFolders.includes(actual) && pathExistsSync(path.join(resolved, actual))) {
    actualFolders.push(actual);
  }

  const backups = [];
  for (const actualFolder of actualFolders) {
    const target = path.join(resolved, actualFolder);
    if (!isSubPath(resolved, target)) throw new AppError('无效的插件路径', 'BAD_PATH', 400);
    if (options.backup !== false) {
      backups.push(
        await createBackup(
          target,
          {
            folder: actualFolder,
            source: pkg?.source || '',
            remoteId: pkg?.remoteId || '',
            remoteName: pkg?.remoteName || base,
            version: pkg?.installedVersion || '',
            icon: pkg?.icon || '',
            url: pkg?.url || '',
          },
          'before-uninstall',
        ),
      );
    }
    try {
      await fsp.rm(target, { recursive: true, force: true });
    } catch (error) {
      throw new AppError(`删除插件失败：${error.message}`, 'DELETE_FAILED', 500);
    }
  }

  store.forgetFolders(actualFolders.map((name) => name.replace(/\.disabled$/i, '')));
  store.addHistory({
    type: 'uninstall',
    name: base,
    folder: base,
    folders: actualFolders,
  });
  invalidateScan(resolved);
  return { folder: base, folders: actualFolders, backup: backups[0] || null, backups };
}

async function restoreBackup(backupId, addonPath) {
  const backupPath = path.join(BACKUP_DIR, path.basename(String(backupId || '')));
  const infoPath = path.join(backupPath, 'backup.json');
  if (!pathExistsSync(infoPath)) throw new AppError('备份不存在', 'NOT_FOUND', 404);
  const info = JSON.parse(await fsp.readFile(infoPath, 'utf8'));
  const source = path.join(backupPath, info.storedFolder || info.folder);
  if (!pathExistsSync(source)) throw new AppError('备份文件不完整', 'BACKUP_INVALID', 400);
  const resolved = await ensureAddonPath(addonPath);
  if (await isWowRunning()) throw new AppError('检测到魔兽世界正在运行，请先退出游戏', 'WOW_RUNNING', 409);
  const target = path.join(resolved, info.storedFolder || info.folder);
  if (pathExistsSync(target)) {
    await createBackup(target, { folder: info.folder }, 'before-restore');
    await fsp.rm(target, { recursive: true, force: true });
  }
  await fsp.cp(source, target, { recursive: true, force: true });
  invalidateScan(resolved);
  if (info.metadata?.source && info.metadata?.remoteId) {
    store.recordInstall({
      source: info.metadata.source,
      remoteId: info.metadata.remoteId,
      remoteName: info.metadata.remoteName || info.folder,
      remoteVersion: info.metadata.version || '',
      folders: [info.folder],
      icon: info.metadata.icon || '',
      url: info.metadata.url || '',
      zipName: 'restore',
    });
  }
  store.addHistory({ type: 'restore', name: info.folder, folder: info.folder });
  return { folder: info.folder };
}

async function revealPath(target) {
  if (!target) throw new AppError('路径为空', 'BAD_PATH', 400);
  const resolved = path.resolve(String(target));
  if (!pathExistsSync(resolved)) throw new AppError('路径不存在', 'NOT_FOUND', 404);
  if (process.platform === 'darwin') {
    let stat = null;
    try {
      stat = await fsp.stat(resolved);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) {
      await execFileAsync('/usr/bin/open', [resolved], { timeout: 6000 }).catch(() => {});
    } else {
      await execFileAsync('/usr/bin/open', ['-R', resolved], { timeout: 6000 }).catch(() => {});
    }
    return { ok: true };
  }
  if (process.platform === 'win32') {
    await execFileAsync('explorer.exe', [resolved], { windowsHide: true }).catch(() => {});
    return { ok: true };
  }
  return { ok: false, message: '当前系统不支持自动打开文件夹' };
}

module.exports = {
  parseToc,
  decodeToc,
  chooseToc,
  scanAddons,
  invalidateScan,
  detectFlavors,
  detectInstallations,
  resolveAddonPath,
  ensureAddonPath,
  setEnabled,
  isWowRunning,
  installZip,
  inspectZip,
  uninstallAddon,
  createBackup,
  listBackups,
  restoreBackup,
  directorySize,
  revealPath,
  stripWowColors,
};
