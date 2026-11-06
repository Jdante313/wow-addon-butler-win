'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { WTF_BACKUP_DIR, ensureDirs } = require('../config');
const { AppError } = require('./errors');
const { isSubPath, normalizeName, timestampSlug, uid } = require('./utils');

function clientDirFromAddonPath(addonPath) {
  if (!addonPath) return '';
  const normalized = path.resolve(addonPath);
  return path.dirname(path.dirname(normalized));
}

function wtfDirFromAddonPath(addonPath) {
  const clientDir = clientDirFromAddonPath(addonPath);
  return clientDir ? path.join(clientDir, 'WTF') : '';
}

function normalizedAddonNames(addons = []) {
  const names = new Set();
  for (const addon of addons) {
    for (const value of [
      addon.baseFolder,
      addon.folder,
      addon.name,
      ...(addon.savedVariables || []),
      ...(addon.savedVariablesPerCharacter || []),
    ]) {
      const normalized = normalizeName(value || '');
      if (normalized) names.add(normalized);
    }
  }
  return names;
}

function matchesAddon(fileStem, names) {
  if (!names.size) return false;
  const normalized = normalizeName(fileStem);
  if (!normalized) return false;
  for (const name of names) {
    if (normalized === name) return true;
    if (name.length >= 4 && (normalized.startsWith(name) || name.startsWith(normalized))) return true;
  }
  return false;
}

async function walkSavedVariables(dir, addonPath, acc = { files: [], bytes: 0 }) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      await walkSavedVariables(full, addonPath, acc);
      continue;
    }
    if (!entry.isFile() || !/\.lua$/i.test(entry.name)) continue;
    let stat = null;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue;
    }
    if (stat.size > 64 * 1024 * 1024) continue;
    if (acc.bytes + stat.size > 300 * 1024 * 1024) break;
    acc.bytes += stat.size;
    acc.files.push({
      absolutePath: full,
      relativePath: path.relative(path.dirname(path.dirname(addonPath)), full).split(path.sep).join('/'),
      name: entry.name,
      stem: entry.name.replace(/\.lua$/i, ''),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
  return acc;
}

async function listSavedVariables(addonPath, addons = [], options = {}) {
  const includeAll = options.includeAll !== false;
  const wtfDir = wtfDirFromAddonPath(addonPath);
  if (!wtfDir) return { files: [], totalBytes: 0, includeAll };
  const accountDir = path.join(wtfDir, 'Account');
  const names = normalizedAddonNames(addons);
  const collected = await walkSavedVariables(accountDir, addonPath);
  const files = collected.files.filter((file) => includeAll || matchesAddon(file.stem, names));
  return {
    files: files.map(({ absolutePath, ...rest }) => rest),
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    includeAll,
  };
}

function safeRelativeConfigPath(relativePath) {
  const normalized = String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) return '';
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '.')) return '';
  if (parts[0] !== 'WTF') return '';
  return normalized;
}

async function backupExistingConfig(addonPath, relativePath) {
  const clientDir = clientDirFromAddonPath(addonPath);
  const source = path.join(clientDir, relativePath);
  try {
    await fsp.access(source);
  } catch {
    return '';
  }
  ensureDirs();
  const targetDir = path.join(WTF_BACKUP_DIR, `${timestampSlug()}-${uid().slice(-4)}`);
  const target = path.join(targetDir, relativePath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(source, target);
  return target;
}

async function writeConfigFile(addonPath, relativePath, buffer) {
  const safe = safeRelativeConfigPath(relativePath);
  if (!safe) throw new AppError(`无效的配置路径：${relativePath}`, 'BAD_CONFIG_PATH', 400);
  const clientDir = clientDirFromAddonPath(addonPath);
  const target = path.join(clientDir, safe);
  if (!isSubPath(clientDir, target)) {
    throw new AppError('配置路径越界，已阻止恢复', 'BAD_CONFIG_PATH', 400);
  }
  const backupPath = await backupExistingConfig(addonPath, safe);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, buffer);
  return { path: target, backupPath };
}

function restoreConfigFromZip(zip, addonPath, options = {}) {
  const entries = zip.getEntries();
  const summary = { restored: [], errors: [], bytes: 0 };
  for (const entry of entries) {
    const name = String(entry.entryName || '').replace(/\\/g, '/');
    if (!name.startsWith('wtf/') || name.endsWith('/')) continue;
    const relativePath = name.slice('wtf/'.length);
    const safe = safeRelativeConfigPath(relativePath);
    if (!safe) continue;
    if (options.only && !options.only.includes(safe)) continue;
    try {
      const buffer = entry.getData();
      const result = writeConfigFileSync(addonPath, safe, buffer);
      summary.restored.push({ path: safe, ...result });
      summary.bytes += buffer.length;
    } catch (error) {
      summary.errors.push(`${safe}: ${error.message}`);
    }
  }
  return summary;
}

function writeConfigFileSync(addonPath, relativePath, buffer) {
  const fsSync = fs;
  const safe = safeRelativeConfigPath(relativePath);
  if (!safe) throw new AppError(`无效的配置路径：${relativePath}`, 'BAD_CONFIG_PATH', 400);
  const clientDir = clientDirFromAddonPath(addonPath);
  const target = path.join(clientDir, safe);
  if (!isSubPath(clientDir, target)) {
    throw new AppError('配置路径越界，已阻止恢复', 'BAD_CONFIG_PATH', 400);
  }
  let backupPath = '';
  try {
    if (fsSync.existsSync(target)) {
      ensureDirs();
      const targetDir = path.join(WTF_BACKUP_DIR, `${timestampSlug()}-${uid().slice(-4)}`);
      backupPath = path.join(targetDir, safe);
      fsSync.mkdirSync(path.dirname(backupPath), { recursive: true });
      fsSync.copyFileSync(target, backupPath);
    }
  } catch {
    backupPath = '';
  }
  fsSync.mkdirSync(path.dirname(target), { recursive: true });
  fsSync.writeFileSync(target, buffer);
  return { path: target, backupPath };
}

module.exports = {
  clientDirFromAddonPath,
  wtfDirFromAddonPath,
  listSavedVariables,
  safeRelativeConfigPath,
  writeConfigFile,
  restoreConfigFromZip,
  backupExistingConfig,
};
