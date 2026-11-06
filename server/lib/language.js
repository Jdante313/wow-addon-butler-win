'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const ZH_PATTERN = /(zhCN|zhTW|zh_CN|zh_TW|zh-Hans|zh-Hant|Chinese|简体中文|繁体中文|中文)/i;
const EN_LOCALE_PATTERN = /(enUS|enGB|en_US|en_GB)/i;

function hasChinese(text) {
  return /[\u3400-\u9fff]/.test(String(text || ''));
}

const KNOWN_LANGUAGES = [
  ['elvui', 'zh'],
  ['tukui', 'zh'],
  ['details', 'zh'],
  ['weakauras', 'zh'],
  ['deadlybossmods', 'zh'],
  ['dbm', 'zh'],
  ['bigwigs', 'zh'],
  ['littlewigs', 'zh'],
  ['plater', 'zh'],
  ['mythicdungeon', 'zh'],
  ['mdt', 'zh'],
  ['questie', 'zh'],
  ['bagnon', 'zh'],
  ['auctionator', 'zh'],
  ['postal', 'zh'],
  ['masque', 'zh'],
  ['methodraidtools', 'zh'],
  ['rurutia', 'zh'],
  ['pig', 'zh'],
  ['gfnameplates', 'zh'],
  ['ncl', 'zh'],
  ['hekili', 'zh'],
  ['titanbis', 'zh'],
  ['easytimeline', 'zh'],
  ['bgnext', 'zh'],
  ['atlasloot', 'zh'],
  ['leatrix', 'zh'],
  ['baganator', 'zh'],
  ['tradeSkillMaster', 'zh'],
];

const CURATED_LANGUAGES = new Map(KNOWN_LANGUAGES);

function knownLanguage(name, summary = '') {
  const nameText = String(name || '').toLowerCase();
  if (hasChinese(name)) {
    return 'zh';
  }
  for (const [key, language] of CURATED_LANGUAGES) {
    if (nameText.includes(key.toLowerCase())) return language;
  }
  return '';
}

function normalizeLanguage(code) {
  if (code === 'zh' || code === 'en') return code;
  return 'unknown';
}

function languageLabel(code, short = false) {
  if (code === 'zh') return short ? '中文' : '中文界面';
  if (code === 'en') return short ? '无中文' : '英文（未发现中文）';
  return short ? '待检测' : '语言待检测';
}

async function readTextLimited(file, limit = 220 * 1024) {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > limit) return '';
    return await fsp.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

async function localeEvidence(folderPath) {
  let entries = [];
  try {
    entries = await fsp.readdir(folderPath, { withFileTypes: true });
  } catch {
    return { zh: false, en: false, evidence: '' };
  }
  let zh = false;
  let en = false;
  const evidence = [];

  for (const dirName of ['Localization', 'Locales', 'localization', 'locales', 'Language']) {
    const dir = entries.find(
      (entry) => entry.isDirectory() && entry.name.toLowerCase() === dirName.toLowerCase(),
    );
    if (!dir) continue;
    let files = [];
    try {
      files = await fsp.readdir(path.join(folderPath, dir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (ZH_PATTERN.test(file.name)) {
        zh = true;
        evidence.push(`${dir.name}/${file.name}`);
      } else if (EN_LOCALE_PATTERN.test(file.name)) {
        en = true;
      }
    }
  }

  if (!zh) {
    const candidates = entries.filter(
      (entry) => entry.isFile() && /\.(lua|xml|toc)$/i.test(entry.name),
    );
    for (const file of candidates.slice(0, 24)) {
      const text = await readTextLimited(path.join(folderPath, file.name));
      if (ZH_PATTERN.test(text)) {
        zh = true;
        evidence.push(file.name);
        break;
      }
    }
  }

  return { zh, en, evidence: evidence.join(', ') };
}

async function detectAddonLanguage(folderPath, toc = {}) {
  const meta = toc.meta || {};
  const localization = String(meta['X-Localization'] || meta['x-localization'] || '');
  if (localization && ZH_PATTERN.test(localization)) {
    return { code: 'zh', evidence: 'TOC X-Localization' };
  }
  if (
    ['Title-zhCN', 'Notes-zhCN', 'Title-zhTW', 'Notes-zhTW'].some(
      (key) => meta[key] && hasChinese(meta[key]),
    )
  ) {
    return { code: 'zh', evidence: 'TOC 中文标题/说明' };
  }
  if (hasChinese(toc.title) || hasChinese(toc.notes)) {
    return { code: 'zh', evidence: 'TOC 中文文本' };
  }

  const locale = await localeEvidence(folderPath);
  if (locale.zh) {
    return { code: 'zh', evidence: locale.evidence || '中文 locale 文件' };
  }
  if (localization && !ZH_PATTERN.test(localization)) {
    return {
      code: 'en',
      evidence: `TOC X-Localization 未包含中文（${localization.slice(0, 60)}）`,
    };
  }
  if (locale.en) {
    return { code: 'en', evidence: '仅发现 enUS/enGB locale' };
  }
  return {
    code: 'en',
    evidence: '未发现 zhCN/zhTW 本地化',
    lowConfidence: true,
  };
}

module.exports = {
  hasChinese,
  knownLanguage,
  normalizeLanguage,
  languageLabel,
  detectAddonLanguage,
};
