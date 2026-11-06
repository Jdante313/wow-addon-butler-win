'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const APP_ROOT = path.resolve(__dirname, '..');
const APP_NAME = '魔兽插件管家';
const APP_VERSION = '2.2.1';
const APP_PLATFORM = process.platform;

function defaultDataDir() {
  if (process.env.WOW_BUTLER_DATA) return path.resolve(process.env.WOW_BUTLER_DATA);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'WowAddonButler');
  }
  if (process.platform === 'win32') {
    // Portable Windows build: keep data next to the executable unless the
    // launcher or a test explicitly overrides WOW_BUTLER_DATA.
    return path.join(APP_ROOT, 'data');
  }
  return path.join(os.homedir(), '.local', 'share', 'wow-addon-butler');
}

const DATA_DIR = defaultDataDir();
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const MANAGED_FILE = path.join(DATA_DIR, 'managed.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PROFILE_DIR = path.join(DATA_DIR, 'profiles');
const WTF_BACKUP_DIR = path.join(DATA_DIR, 'wtf-backups');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

const FLAVORS = {
  retail: {
    key: 'retail',
    label: '正式服',
    short: '正式服',
    folder: '_retail_',
    wclbox: 2,
    hint: '正式服 / Retail',
    interface: [120000, 120100, 120105],
  },
  titan: {
    key: 'titan',
    label: '泰坦重铸',
    short: '泰坦',
    folder: '_classic_',
    wclbox: 4,
    hint: '泰坦重铸 / 时光服',
    interface: [38000, 38002, 38005],
  },
  mists: {
    key: 'mists',
    label: '熊猫人之谜',
    short: 'Mists',
    folder: '_classic_',
    wclbox: 7,
    hint: '经典服 · 熊猫人之谜',
    interface: [50500, 50504],
  },
  tbc: {
    key: 'tbc',
    label: '燃烧的远征',
    short: 'TBC',
    folder: '_classic_',
    wclbox: 8,
    hint: '经典服 · 燃烧的远征',
    interface: [20504, 20505],
  },
  classic: {
    key: 'classic',
    label: '经典旧世',
    short: '经典',
    folder: '_classic_era_',
    wclbox: 6,
    hint: '经典旧世 / Era',
    interface: [11507, 11508],
  },
  sod: {
    key: 'sod',
    label: '探索赛季',
    short: 'SoD',
    folder: '_classic_era_',
    wclbox: 3,
    hint: '探索赛季 / Season of Discovery',
    interface: [11507, 11508],
  },
  anniversary: {
    key: 'anniversary',
    label: '经典旧世 · 周年',
    short: '周年',
    folder: '_anniversary_',
    wclbox: 6,
    hint: 'Classic Anniversary',
    interface: [11507, 11508],
  },
  unlimited: {
    key: 'unlimited',
    label: '无限',
    short: '无限',
    folder: '_forever_',
    folders: ['_forever_', '_classic_beta_'],
    wclbox: 9,
    hint: '魔兽世界：无限 / WoW Forever',
    interface: [],
  },
  custom: {
    key: 'custom',
    label: '自定义客户端',
    short: '自定义',
    folder: '',
    wclbox: 4,
    hint: '自定义 / 私服客户端，沿用当前插件目录',
    interface: [],
  },
};

const DEFAULT_SETTINGS = {
  wowRoot: '',
  flavor: 'retail',
  addonPath: '',
  wclboxVersion: 2,
  browseVersion: 0,
  wclboxCategory: 0,
  sources: {
    wclbox: false,
    curseforge: false,
    tukui: true,
    wowinterface: false,
    github: false,
  },
  curseforgeApiKey: '',
  sort: 'popular',
  autoCheckUpdates: true,
  backupBeforeUpdate: true,
  backupLimit: 8,
  maxDownloads: 3,
  profileIncludeFiles: true,
  profileIncludeConfig: true,
  firstRun: true,
  uiScale: 1,
  lastCheckAt: '',
  lastProfileAt: '',
};

function ensureDirs() {
  for (const dir of [
    DATA_DIR,
    BACKUP_DIR,
    PROFILE_DIR,
    WTF_BACKUP_DIR,
    CACHE_DIR,
    LOG_DIR,
    TMP_DIR,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function findFlavor(key) {
  return FLAVORS[key] || FLAVORS.retail;
}

module.exports = {
  APP_ROOT,
  APP_NAME,
  APP_VERSION,
  APP_PLATFORM,
  DATA_DIR,
  SETTINGS_FILE,
  MANAGED_FILE,
  BACKUP_DIR,
  PROFILE_DIR,
  WTF_BACKUP_DIR,
  CACHE_DIR,
  LOG_DIR,
  TMP_DIR,
  FLAVORS,
  DEFAULT_SETTINGS,
  ensureDirs,
  findFlavor,
};
