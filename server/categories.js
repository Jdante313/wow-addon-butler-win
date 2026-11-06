'use strict';

/**
 * Shared category taxonomy for the search page.
 *
 * CurseForge and 新手盒子 have their own category IDs, so each entry carries
 * the upstream hints. Sources without category APIs are filtered by keywords
 * after their search results come back.
 */
const SEARCH_CATEGORIES = [
  {
    key: 'all',
    label: '全部插件',
    short: '全部',
    wclbox: 0,
    cfNames: [],
    keywords: [],
  },
  {
    key: 'raid',
    label: '副本与团队',
    short: '副本',
    wclbox: 1014,
    cfNames: ['Boss Encounters', 'Boss Mods', 'Raids', 'Dungeons'],
    keywords: [
      'dbm',
      'deadly boss',
      'bigwigs',
      'littlewigs',
      'method raid',
      'raid tools',
      'mythic dungeon',
      'mdt',
      'dungeon',
      'dungeons',
      'boss',
      '开荒',
      '副本',
      '团队',
      '大秘境',
      '首领',
      '地下城',
    ],
  },
  {
    key: 'ui',
    label: '界面美化',
    short: '界面',
    wclbox: 1006,
    cfNames: ['Action Bars', 'Unit Frames', 'Artwork', 'UI'],
    keywords: [
      'elvui',
      'tukui',
      'unit frame',
      'unit frames',
      'action bar',
      'action bars',
      'nameplate',
      'nameplates',
      'masque',
      'skin',
      'skins',
      'theme',
      'interface',
      '界面',
      '动作条',
      '单位框架',
      '姓名板',
      '美化',
      '材质',
      '布局',
    ],
  },
  {
    key: 'combat',
    label: '战斗与监控',
    short: '战斗',
    wclbox: 1019,
    cfNames: ['Combat', 'Damage Meters', 'Combat Logs'],
    keywords: [
      'details',
      'skada',
      'recount',
      'damage meter',
      'damage meters',
      'combat log',
      'dps',
      'healing',
      'threat',
      '战斗统计',
      '伤害统计',
      '治疗统计',
      '仇恨',
      '战斗分析',
      '伤害',
    ],
  },
  {
    key: 'bags',
    label: '背包与银行',
    short: '背包',
    wclbox: 1009,
    cfNames: ['Bags & Inventory', 'Bags', 'Inventory'],
    keywords: [
      'bagnon',
      'baganator',
      'inventory',
      'bank',
      'vendor',
      'bag',
      'bags',
      '背包',
      '银行',
      '物品',
      '整理',
    ],
  },
  {
    key: 'auction',
    label: '拍卖与商业',
    short: '商业',
    wclbox: 1002,
    cfNames: ['Auction House', 'Professions', 'Trade Skills', 'Economy'],
    keywords: [
      'auction',
      'auctionator',
      'trade skill',
      'trade skills',
      'profession',
      'professions',
      'postal',
      'mail',
      '拍卖',
      '商业',
      '专业',
      '邮件',
      '金币',
      '地精',
    ],
  },
  {
    key: 'quest',
    label: '任务与探索',
    short: '任务',
    wclbox: 1013,
    cfNames: ['Quests & Leveling', 'Quests', 'Leveling'],
    keywords: [
      'questie',
      'quest',
      'quests',
      'waypoint',
      'rare',
      'treasure',
      'map',
      '任务',
      '地图',
      '稀有',
      '宝箱',
      '探索',
      '升级',
    ],
  },
  {
    key: 'class',
    label: '职业与 WA',
    short: '职业',
    wclbox: 1020,
    cfNames: ['Class', 'Classes', 'Profiles'],
    keywords: [
      'weakauras',
      'weakaura',
      'rotation',
      'hekil',
      'talent',
      'talents',
      'class',
      '职业',
      '循环',
      '天赋',
      '配装',
    ],
  },
  {
    key: 'pvp',
    label: 'PvP',
    short: 'PvP',
    wclbox: 1004,
    cfNames: ['PvP', 'Arena', 'Battlegrounds'],
    keywords: ['pvp', 'arena', 'battleground', 'battlegrounds', '竞技场', '战场', '评级', '对抗'],
  },
];

const byKey = new Map(SEARCH_CATEGORIES.map((category) => [category.key, category]));

function getCategory(key) {
  return byKey.get(String(key || 'all')) || byKey.get('all');
}

function wclboxCategoryId(key) {
  return getCategory(key).wclbox || 0;
}

function curseforgeCategoryNames(key) {
  return getCategory(key).cfNames || [];
}

function categoryHaystack(item) {
  return [
    item.name,
    item.summary,
    Array.isArray(item.categories) ? item.categories.join(' ') : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function matchesCategory(item, key) {
  const category = getCategory(key);
  if (category.key === 'all') return true;
  const text = categoryHaystack(item);
  if (!text) return false;
  return category.keywords.some((keyword) => {
    const value = String(keyword).toLowerCase();
    if (/^[a-z0-9]+$/.test(value) && value.length <= 3) {
      return new RegExp(`(^|[^a-z0-9])${value}([^a-z0-9]|$)`).test(text);
    }
    return text.includes(value);
  });
}

function categoryLabel(key) {
  return getCategory(key).label;
}

module.exports = {
  SEARCH_CATEGORIES,
  getCategory,
  wclboxCategoryId,
  curseforgeCategoryNames,
  matchesCategory,
  categoryLabel,
};
