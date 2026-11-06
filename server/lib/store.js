'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  APP_NAME,
  APP_VERSION,
  DEFAULT_SETTINGS,
  SETTINGS_FILE,
  MANAGED_FILE,
  ensureDirs,
} = require('../config');
const { readJsonSync, writeJsonSync } = require('./utils');

let settingsCache = null;
let managedCache = null;

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (base && patch && typeof base === 'object' && typeof patch === 'object') {
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      out[key] = deepMerge(base[key], value);
    }
    return out;
  }
  return patch;
}

function sanitizeSettings(input) {
  const settings = deepMerge(DEFAULT_SETTINGS, input || {});
  settings.wowRoot = String(settings.wowRoot || '');
  settings.addonPath = String(settings.addonPath || '');
  settings.flavor = String(settings.flavor || 'titan');
  settings.wclboxVersion = Number(settings.wclboxVersion) || 4;
  settings.browseVersion = Number(settings.browseVersion) || 0;
  settings.wclboxCategory = Number(settings.wclboxCategory) || 0;
  settings.uiScale = Math.max(0.8, Math.min(2, Number(settings.uiScale) || 1));
  settings.curseforgeApiKey = String(settings.curseforgeApiKey || '').trim();
  settings.backupLimit = Math.max(1, Math.min(30, Number(settings.backupLimit) || 8));
  settings.maxDownloads = Math.max(1, Math.min(6, Number(settings.maxDownloads) || 3));
  settings.profileIncludeFiles = settings.profileIncludeFiles !== false;
  settings.profileIncludeConfig = settings.profileIncludeConfig !== false;
  settings.sources = {
    wclbox: settings.sources?.wclbox !== false,
    curseforge: settings.sources?.curseforge !== false,
    tukui: settings.sources?.tukui !== false,
    wowinterface: settings.sources?.wowinterface === true,
    github: settings.sources?.github === true,
  };
  return settings;
}

function loadSettings() {
  if (settingsCache) return settingsCache;
  ensureDirs();
  const raw = readJsonSync(SETTINGS_FILE, null);
  settingsCache = sanitizeSettings(raw || {});
  if (!fs.existsSync(SETTINGS_FILE)) saveSettings({});
  return settingsCache;
}

function saveSettings(patch = {}) {
  ensureDirs();
  const current = settingsCache || sanitizeSettings(readJsonSync(SETTINGS_FILE, {}) || {});
  settingsCache = sanitizeSettings(deepMerge(current, patch));
  writeJsonSync(SETTINGS_FILE, settingsCache);
  return settingsCache;
}

function publicSettings() {
  const settings = loadSettings();
  return {
    ...settings,
    curseforgeApiKey: '',
    curseforgeApiKeySet: Boolean(settings.curseforgeApiKey),
    appName: APP_NAME,
    appVersion: APP_VERSION,
    appPlatform: process.platform,
    dataDir: path.dirname(SETTINGS_FILE),
  };
}

function loadManaged() {
  if (managedCache) return managedCache;
  ensureDirs();
  const raw = readJsonSync(MANAGED_FILE, null);
  managedCache = {
    version: 1,
    packages: raw?.packages && typeof raw.packages === 'object' ? raw.packages : {},
    folders: raw?.folders && typeof raw.folders === 'object' ? raw.folders : {},
    history: Array.isArray(raw?.history) ? raw.history.slice(0, 200) : [],
  };
  return managedCache;
}

function saveManaged() {
  ensureDirs();
  writeJsonSync(MANAGED_FILE, managedCache || { version: 1, packages: {}, folders: {}, history: [] });
  return managedCache;
}

function recordInstall({ source, remoteId, remoteName, remoteVersion, folders, icon, url, zipName }) {
  const managed = loadManaged();
  const packageId = `${source}:${remoteId}`;
  const now = new Date().toISOString();
  const existing = managed.packages[packageId] || {};
  managed.packages[packageId] = {
    ...existing,
    id: packageId,
    source,
    remoteId: String(remoteId),
    remoteName: remoteName || existing.remoteName || '',
    remoteVersion: remoteVersion || existing.remoteVersion || '',
    installedVersion: remoteVersion || existing.installedVersion || '',
    folders: Array.from(new Set(folders || [])),
    icon: icon || existing.icon || '',
    url: url || existing.url || '',
    zipName: zipName || existing.zipName || '',
    installedAt: existing.installedAt || now,
    updatedAt: now,
    pinned: Boolean(existing.pinned),
  };
  for (const folder of folders || []) {
    managed.folders[String(folder).toLowerCase()] = packageId;
  }
  managed.history.unshift({
    type: 'install',
    source,
    remoteId: String(remoteId),
    name: remoteName || '',
    version: remoteVersion || '',
    folders: folders || [],
    at: now,
  });
  managed.history = managed.history.slice(0, 200);
  saveManaged();
  return managed.packages[packageId];
}

function forgetFolders(folders) {
  const managed = loadManaged();
  let changed = false;
  for (const folder of folders || []) {
    const key = String(folder).toLowerCase();
    const packageId = managed.folders[key];
    if (packageId) {
      delete managed.folders[key];
      changed = true;
    }
  }
  if (changed) saveManaged();
  return managed;
}

function packageForFolder(folder) {
  const managed = loadManaged();
  const packageId = managed.folders[String(folder).toLowerCase()];
  return packageId ? managed.packages[packageId] || null : null;
}

function setPinned(packageId, pinned) {
  const managed = loadManaged();
  if (!managed.packages[packageId]) return null;
  managed.packages[packageId].pinned = Boolean(pinned);
  managed.packages[packageId].updatedAt = new Date().toISOString();
  saveManaged();
  return managed.packages[packageId];
}

function addHistory(entry) {
  const managed = loadManaged();
  managed.history.unshift({ ...entry, at: new Date().toISOString() });
  managed.history = managed.history.slice(0, 200);
  saveManaged();
}

module.exports = {
  loadSettings,
  saveSettings,
  publicSettings,
  loadManaged,
  saveManaged,
  recordInstall,
  forgetFolders,
  packageForFolder,
  setPinned,
  addHistory,
};
