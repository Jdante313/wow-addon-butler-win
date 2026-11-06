'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uid(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function stripHtml(input = '') {
  return safeString(input)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanText(input = '') {
  return stripHtml(input).replace(/\s+/g, ' ').trim();
}

function normalizeName(input = '') {
  return cleanText(input)
    .toLowerCase()
    .replace(/^!+/, '')
    .replace(/\|c[0-9a-f]{8}|\|r/gi, '')
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/\b(v|ver|version)\s*[\d.]+/gi, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}

function versionParts(version = '') {
  const text = safeString(version)
    .replace(/\.zip$/i, '')
    .replace(/^[a-z_\-\s]+/i, '');
  const matches = text.match(/\d+(?:\.\d+){0,5}/g);
  if (!matches || !matches.length) return [];
  return matches
    .map((part) => part.split('.').map((n) => Number(n)))
    .sort((a, b) => b.length - a.length)[0]
    .map((n) => (Number.isFinite(n) ? n : 0));
}

function compareVersions(a, b) {
  const av = versionParts(a);
  const bv = versionParts(b);
  if (!av.length || !bv.length) return null;
  const length = Math.max(av.length, bv.length);
  for (let i = 0; i < length; i += 1) {
    const x = av[i] || 0;
    const y = bv[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function isVersionNewer(remote, installed) {
  const result = compareVersions(remote, installed);
  if (result === null) {
    const r = safeString(remote).trim().toLowerCase();
    const i = safeString(installed).trim().toLowerCase();
    return Boolean(r && i && r !== i);
  }
  return result > 0;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function normalizeDate(value) {
  if (!value) return '';
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function timestampSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function isSubPath(parent, child) {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  const relative = path.relative(parentResolved, childResolved);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeFileName(name, fallback = 'addon.zip') {
  const base = path.basename(safeString(name, fallback)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  return base || fallback;
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

function pathExistsSync(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSync(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function escapeRegExp(text) {
  return safeString(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  sleep,
  uid,
  safeString,
  stripHtml,
  cleanText,
  normalizeName,
  versionParts,
  compareVersions,
  isVersionNewer,
  formatBytes,
  normalizeDate,
  timestampSlug,
  isSubPath,
  safeFileName,
  pathExists,
  pathExistsSync,
  readJson,
  readJsonSync,
  writeJsonSync,
  mapLimit,
  escapeRegExp,
};
