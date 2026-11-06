import { icon, hydrateIcons } from './icons.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const FLAVOR_LABELS = {
  retail: '正式服',
  titan: '泰坦重铸',
  mists: '熊猫人之谜',
  tbc: '燃烧的远征',
  classic: '经典旧世',
  sod: '探索赛季',
  anniversary: '经典旧世 · 周年',
  unlimited: '无限',
  custom: '自定义客户端',
};

const SOURCES = {
  wclbox: { label: '新手盒子', tag: 'tag-amber', short: '新' },
  curseforge: { label: 'CurseForge', tag: 'tag-red', short: 'CF' },
  tukui: { label: 'Tukui', tag: 'tag-teal', short: 'TU' },
  wowinterface: { label: 'WoWInterface', tag: 'tag-blue', short: 'WI' },
  github: { label: 'GitHub', tag: 'tag-plain', short: 'GH' },
  local: { label: '本地压缩包', tag: 'tag-plain', short: 'ZIP' },
  profile: { label: '配置快照', tag: 'tag-plain', short: 'PK' },
};

const CF_APPLY_URL = 'https://console.curseforge.com/?#/api-keys';

const SORT_OPTIONS = [
  { key: 'popular', label: '热度' },
  { key: 'updated', label: '最近更新' },
  { key: 'name', label: '名称' },
];

const FALLBACK_CATEGORIES = [
  { key: 'all', label: '全部插件' },
  { key: 'raid', label: '副本与团队' },
  { key: 'ui', label: '界面美化' },
  { key: 'combat', label: '战斗与监控' },
  { key: 'bags', label: '背包与银行' },
  { key: 'auction', label: '拍卖与商业' },
  { key: 'quest', label: '任务与探索' },
  { key: 'class', label: '职业与 WA' },
  { key: 'pvp', label: 'PvP' },
];

const FALLBACK_VERSIONS = [
  { key: 'unlimited', label: '无限', wclbox: 9 },
  { key: 'retail', label: '正式服', wclbox: 2 },
  { key: 'titan', label: '泰坦重铸', wclbox: 4 },
  { key: 'classic', label: '经典旧世', wclbox: 6 },
  { key: 'sod', label: '探索赛季', wclbox: 3 },
  { key: 'mists', label: '熊猫人之谜', wclbox: 7 },
  { key: 'tbc', label: '燃烧的远征', wclbox: 8 },
  { key: 'anniversary', label: '经典旧世 · 周年', wclbox: 6 },
];

const BROWSE_VERSION_PREFIX = {
  unlimited: '1.60',
  retail: '12',
  titan: '3.80',
  classic: '1.15',
  sod: '1.15',
  mists: '5.5',
  tbc: '2.5',
  anniversary: '1.15',
};

const BACKUP_REASONS = {
  'before-install': '覆盖安装前',
  'before-update': '更新前',
  'before-uninstall': '卸载前',
  'before-restore': '恢复前',
  manual: '手动备份',
  unknown: '备份',
};

const state = {
  route: 'installed',
  bootstrap: null,
  installed: null,
  installedFilter: 'all',
  installedQuery: '',
  search: {
    query: '',
    source: 'all',
    category: 'all',
    sort: 'popular',
    versionKey: '',
    page: 1,
    items: [],
    groups: [],
    total: 0,
    exactCount: 0,
    fuzzyCount: 0,
    hasMore: false,
    loading: false,
    loaded: false,
    error: '',
    appendError: '',
    scrollCleanup: null,
    req: 0,
  },
  profiles: [],
  backups: [],
  profilesLoaded: false,
  backupsLoaded: false,
  tasks: new Map(),
  confirmResolver: null,
  lastSearchSource: 'all',
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeImage(url) {
  const value = String(url || '');
  if (!/^https?:\/\//i.test(value)) return '';
  return esc(value);
}

function initial(name) {
  const cleaned = String(name || '?')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .trim();
  if (!cleaned) return '?';
  if (/^[\x00-\x7F]/.test(cleaned)) return cleaned.slice(0, 2).toUpperCase();
  return cleaned.slice(0, 1);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

function formatCount(value) {
  const number = Number(value) || 0;
  if (number >= 100000000) return `${(number / 100000000).toFixed(1)} 亿`;
  if (number >= 10000) return `${(number / 10000).toFixed(1)} 万`;
  if (number >= 1000) return number.toLocaleString('zh-CN');
  return String(number);
}

function pad(number) {
  return String(number).padStart(2, '0');
}

function formatDate(value, withTime = false) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const base = `${
    date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}/`
  }${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  return withTime ? `${base} ${pad(date.getHours())}:${pad(date.getMinutes())}` : base;
}

function formatRelative(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return formatDate(value);
}

function shortPath(value, max = 46) {
  const text = String(value || '');
  if (!text) return '';
  const home = window.__HOME__ || '';
  const normalized = home && text.startsWith(home) ? `~${text.slice(home.length)}` : text;
  if (normalized.length <= max) return normalized;
  const parts = normalized.split('/');
  if (parts.length <= 2) return `…${normalized.slice(-max + 1)}`;
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`;
}

function sourceLabel(id) {
  return SOURCES[id]?.label || id || '本地';
}

function sourceTag(id) {
  const meta = SOURCES[id];
  if (!meta) return '<span class="muted">本地</span>';
  return `<span class="tag ${meta.tag}">${esc(meta.label)}</span>`;
}

function languageTag(code) {
  if (code === 'zh') return '<span class="tag tag-green">中文</span>';
  if (code === 'en') return '<span class="tag tag-plain">无中文</span>';
  return '';
}

function parseVersionText(value) {
  const match = String(value || '').match(/(\d+(?:\.\d+){0,3})/);
  if (!match) return null;
  const parts = match[1].split('.').map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
  return { parts, text: parts.slice(0, 2).join('.'), raw: String(value).trim() };
}

function supportedVersionList(item) {
  const values = Array.isArray(item?.compatible) ? item.compatible : [];
  const seen = new Set();
  const parsed = [];
  for (const value of values) {
    const entry = parseVersionText(value);
    if (!entry || seen.has(entry.text)) continue;
    seen.add(entry.text);
    parsed.push(entry);
  }
  parsed.sort((a, b) => {
    const length = Math.max(a.parts.length, b.parts.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
      if (diff) return diff;
    }
    return 0;
  });
  return parsed;
}

function supportedVersionTag(item) {
  const list = supportedVersionList(item);
  if (!list.length) return '';
  const browse = browseVersionEntry(state.search.versionKey);
  const prefix = BROWSE_VERSION_PREFIX[browse?.key] || '';
  const matching = prefix
    ? list.filter((entry) => entry.text === prefix || entry.text.startsWith(`${prefix}.`))
    : [];
  const primary = matching.length ? matching[matching.length - 1] : list[list.length - 1];
  const suffix = list.length > 1 ? ` +${list.length - 1}` : '';
  const all = list.map((entry) => entry.text).join(' / ');
  return `<span class="tag tag-version" title="支持版本：${esc(
    all,
  )}">支持 ${esc(primary.text)}${suffix}</span>`;
}

function muted(text) {
  return `<span class="muted">${esc(text)}</span>`;
}

function openExternal(url) {
  if (!url) return;
  if (window.webkit?.messageHandlers?.openExternal) {
    window.webkit.messageHandlers.openExternal.postMessage(String(url));
    return;
  }
  window.open(String(url), '_blank', 'noopener');
}

async function api(pathname, options = {}) {
  const { method = 'GET', body, query } = options;
  let url = pathname;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, value);
    }
    const text = params.toString();
    if (text) url += `?${text}`;
  }
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error('无法连接本地服务，请重新打开软件');
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`本地服务返回了异常数据（HTTP ${response.status}）`);
  }
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`);
  }
  return payload.data;
}

function toast(message, type = 'success', timeout = 3400) {
  const stack = $('#toast-stack');
  const node = document.createElement('div');
  const iconName = type === 'error' ? 'xCircle' : type === 'info' ? 'info' : 'checkCircle';
  node.className = `toast toast-${type}`;
  node.innerHTML = `${icon(iconName, 16)}<span>${esc(message)}</span>`;
  stack.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(-4px)';
    setTimeout(() => node.remove(), 180);
  }, timeout);
}

function setButtonBusy(button, label = '处理中…') {
  if (!button) return () => {};
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner" style="width:12px;height:12px"></span>${esc(label)}`;
  return () => {
    button.disabled = false;
    button.innerHTML = original;
  };
}

/* ------------------------------------------------------------------ */
/* modal                                                               */
/* ------------------------------------------------------------------ */

function renderModal({ title, subtitle = '', body = '', footer = '', size = '' }) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}" tabindex="-1">
        <div class="modal-head">
          <div class="modal-head-copy">
            <h2 class="modal-title">${esc(title)}</h2>
            ${subtitle ? `<p class="modal-subtitle">${subtitle}</p>` : ''}
          </div>
          <button class="icon-btn modal-close" type="button" data-action="close-modal" aria-label="关闭">
            ${icon('x', 17)}
          </button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  hydrateIcons(root);
  const modal = $('.modal', root);
  if (modal) modal.focus({ preventScroll: true });
}

function closeModal() {
  $('#modal-root').innerHTML = '';
  if (state.confirmResolver) {
    state.confirmResolver(false);
    state.confirmResolver = null;
  }
}

function confirmDialog({ title, message, confirmText = '确认', danger = false }) {
  return new Promise((resolve) => {
    state.confirmResolver = resolve;
    renderModal({
      title,
      size: 'modal-sm',
      body: `<p class="confirm-text">${esc(message)}</p>`,
      footer: `
        <button class="btn" type="button" data-action="confirm-cancel">取消</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="button" data-action="confirm-ok">${esc(
          confirmText,
        )}</button>`,
    });
  });
}

function resolveConfirm(value) {
  if (state.confirmResolver) {
    const resolver = state.confirmResolver;
    state.confirmResolver = null;
    closeModal();
    resolver(value);
  }
}

/* ------------------------------------------------------------------ */
/* chrome                                                              */
/* ------------------------------------------------------------------ */

function currentClient() {
  const clients = state.bootstrap?.clients || [];
  return clients.find((client) => client.current) || clients[0] || null;
}

function applyUiScale(value) {
  const scale = Math.max(0.8, Math.min(2, Number(value) || 1));
  document.documentElement.style.zoom = String(scale);
  document.documentElement.dataset.uiScale = String(scale);
  document.documentElement.classList.toggle('ui-compact', scale >= 1.2);
}

function updateChrome() {
  const bootstrap = state.bootstrap;
  if (!bootstrap) return;
  const stats = bootstrap.scan?.stats || {};
  const navCount = $('#nav-installed-count');
  if (navCount) {
    navCount.textContent = stats.total ? String(stats.total) : '';
  }
  const client = currentClient();
  const label = $('#client-card-label');
  const pathNode = $('#client-card-path');
  if (label) {
    if (!client && !bootstrap.target?.addonPath) {
      label.textContent = '未选择客户端';
      label.title = '';
    } else {
      const flavor = client?.key || bootstrap.settings?.flavor;
      const version = client?.versionShort || '';
      label.textContent = `${FLAVOR_LABELS[flavor] || client?.label || '未选择客户端'}`;
      label.title = version ? `${label.textContent} · ${version}` : label.textContent;
    }
  }
  if (pathNode) {
    const target = client?.addonPath || bootstrap.settings?.addonPath || '';
    pathNode.textContent = target ? shortPath(target, 34) : '在设置中选择游戏目录';
    pathNode.title = target || '';
  }
  const versionNode = $('#app-version');
  if (versionNode) versionNode.textContent = `v${bootstrap.settings?.appVersion || ''}`;
}

function setActiveNav(route) {
  for (const item of $$('.nav-item')) {
    item.classList.toggle('active', item.dataset.route === route);
  }
}

/* ------------------------------------------------------------------ */
/* routing                                                             */
/* ------------------------------------------------------------------ */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, queryString] = raw.split('?');
  const params = new URLSearchParams(queryString || '');
  return {
    name: name || 'installed',
    params,
  };
}

function navigate(hash) {
  if (location.hash === hash) {
    renderRoute();
    return;
  }
  location.hash = hash;
}

async function loadBootstrap(force = false) {
  state.bootstrap = await api('/api/bootstrap', {
    query: force ? { refresh: '1' } : {},
  });
  applyUiScale(state.bootstrap.settings?.uiScale);
  updateChrome();
}

async function renderRoute() {
  const { name, params } = parseHash();
  const route = ['installed', 'search', 'backup', 'settings'].includes(name) ? name : 'installed';
  state.route = route;
  setActiveNav(route);

  if (route === 'installed') {
    await loadInstalled(false);
  } else if (route === 'search') {
    const query = params.get('q');
    const source = params.get('source');
    const category = params.get('category');
    const sort = params.get('sort');
    const version = params.get('version');
    if (query !== null) state.search.query = query;
    if (source) state.search.source = source;
    if (category && searchCategories().some((entry) => entry.key === category)) {
      state.search.category = category;
    }
    if (sort && SORT_OPTIONS.some((entry) => entry.key === sort)) state.search.sort = sort;
    if (version && browseVersions().some((entry) => entry.key === version)) {
      state.search.versionKey = version;
    }
    if (!state.search.versionKey) state.search.versionKey = defaultBrowseVersion();
    state.search.loaded = false;
    renderSearchPage();
    if (enabledSources().length) await loadSearch(false);
  } else if (route === 'backup') {
    await loadBackupPage();
  } else if (route === 'settings') {
    renderSettings();
  }
}

/* ------------------------------------------------------------------ */
/* installed                                                           */
/* ------------------------------------------------------------------ */

function getInstalledStats(data) {
  const addons = data?.addons || [];
  const visible = addons.filter((addon) => !addon.isLibrary || addon.managed);
  return {
    visible: visible.length,
    all: addons.length,
    enabled: visible.filter((addon) => addon.enabled).length,
    disabled: visible.filter((addon) => !addon.enabled && !addon.mixed).length,
    mixed: visible.filter((addon) => addon.mixed).length,
    updates: visible.filter((addon) => addon.update?.status === 'update').length,
    libraries: addons.filter((addon) => addon.isLibrary).length,
    folders: data?.folderStats?.total || 0,
  };
}

function clientSelectHtml(clients) {
  const unique = [];
  const seen = new Set();
  for (const client of clients || []) {
    if (!client?.addonPath || seen.has(client.addonPath)) continue;
    seen.add(client.addonPath);
    unique.push(client);
  }
  if (!unique.length) {
    return `<button class="client-select is-static" type="button" data-action="goto-settings">
      ${icon('gamepad', 15)}
      <span class="client-select-label">选择游戏客户端</span>
      <span class="client-select-chevron">${icon('chevronRight', 13)}</span>
    </button>`;
  }
  const familyOf = (client) => FLAVOR_LABELS[client.key] || client.label || client.folder;
  const familyCounts = new Map();
  for (const client of unique) {
    const family = familyOf(client);
    familyCounts.set(family, (familyCounts.get(family) || 0) + 1);
  }
  const options = unique
    .map((client) => {
      const family = familyOf(client);
      const label = `${
        familyCounts.get(family) > 1 && client.versionShort
          ? `${family} · ${client.versionShort}`
          : family
      }`;
      return `<option value="${esc(client.addonPath)}" data-flavor="${esc(client.key)}" ${
        client.current ? 'selected' : ''
      }>${esc(label)}</option>`;
    })
    .join('');
  return `<label class="client-select" title="切换要查看的魔兽版本">
    ${icon('gamepad', 15)}
    <select id="client-select" aria-label="切换魔兽版本">${options}</select>
    <span class="client-select-chevron">${icon('chevronDown', 13)}</span>
  </label>`;
}

function runningBanner(data) {
  if (!data?.wowRunning) return '';
  return `<div class="banner">${icon('alert', 15)}<div><strong>魔兽世界正在运行。</strong>安装、更新、停用或卸载前请先完全退出游戏，避免文件被占用。</div></div>`;
}

async function loadInstalled(force = false) {
  if (!force && state.installed) {
    renderInstalled();
    return;
  }
  if (!state.installed) {
    const view = $('#view');
    view.innerHTML = `<div class="boot"><span class="spinner"></span><p>正在读取本地插件…</p></div>`;
  }
  try {
    state.installed = await api('/api/installed', { query: force ? { refresh: '1' } : {} });
    if (state.installed.clients) {
      state.bootstrap.clients = state.installed.clients;
    }
    if (state.bootstrap?.scan?.stats) {
      state.bootstrap.scan.stats = state.installed.stats || state.bootstrap.scan.stats;
    }
    updateChrome();
  } catch (error) {
    state.installed = null;
    renderFatal(error.message);
    return;
  }
  renderInstalled();
}

function filterCounts(data) {
  const stats = getInstalledStats(data);
  return {
    all: stats.visible,
    enabled: stats.enabled,
    disabled: stats.disabled,
    updates: stats.updates,
    libraries: stats.libraries,
  };
}

function renderInstalled() {
  const view = $('#view');
  const data = state.installed;
  if (!data) {
    view.innerHTML = `<div class="boot"><span class="spinner"></span><p>正在读取本地插件…</p></div>`;
    return;
  }
  const clients = data.clients || state.bootstrap?.clients || [];
  const stats = getInstalledStats(data);
  const counts = filterCounts(data);
  const hasAddons = (data.addons || []).length > 0;

  let body = '';
  if (!data.client?.addonPath && !clients.length) {
    body = `
      <div class="empty">
        <div class="empty-visual">${icon('gamepad', 24)}</div>
        <h2>先选择魔兽世界客户端</h2>
        <p>找到游戏目录后，这里会列出所有已安装插件。也可以先搜索插件，安装时再选择目录。</p>
        <div class="empty-actions">
          <button class="btn btn-primary" type="button" data-action="goto-settings">${icon('folderOpen', 15)} 选择游戏目录</button>
          <button class="btn" type="button" data-action="goto-search">${icon('search', 15)} 搜索插件</button>
        </div>
      </div>`;
  } else if (!hasAddons) {
    const missingDir = data.client && data.client.exists === false;
    body = `
      <div class="empty">
        <div class="empty-visual">${icon('package', 24)}</div>
        <h2>${missingDir ? '这个客户端还没有插件目录' : '还没有安装插件'}</h2>
        <p>${
          missingDir
            ? '第一次安装插件时会自动创建 Interface/AddOns。先去搜索一个顺手的插件吧。'
            : '搜索并安装第一个插件。装好以后，可以在这里启停、更新，并把整套配置保存下来。'
        }</p>
        <div class="empty-actions">
          <button class="btn btn-primary" type="button" data-action="goto-search">${icon('search', 15)} 搜索并安装插件</button>
          <button class="btn" type="button" data-action="install-local">${icon('upload', 15)} 安装本地包</button>
          <button class="btn" type="button" data-action="goto-settings">${icon('sliders', 15)} 检查游戏目录</button>
        </div>
        <div class="empty-foot">${esc(shortPath(data.addonPath || data.client?.addonPath || '尚未选择目录', 60))}</div>
      </div>`;
  } else {
    const chips = [
      ['all', '全部', counts.all],
      ['enabled', '已启用', counts.enabled],
      ['disabled', '已停用', counts.disabled],
      ['updates', '可更新', counts.updates],
      ['libraries', '库', counts.libraries],
    ]
      .map(
        ([key, label, count]) => `
        <button class="chip ${state.installedFilter === key ? 'active' : ''}" type="button"
          data-action="filter-installed" data-filter="${key}">
          ${label}<span class="chip-count">${count}</span>
        </button>`,
      )
      .join('');

    const rows = (data.addons || [])
      .map((addon) => addonRow(addon))
      .join('');

    body = `
      ${runningBanner(data)}
      <div class="toolbar">
        <div class="chip-row">${chips}</div>
        <div class="toolbar-right">
          <label class="local-filter">
            ${icon('search', 14)}
            <input type="search" data-installed-search value="${esc(state.installedQuery)}" placeholder="筛选本地插件" autocomplete="off" />
          </label>
          <button class="btn btn-sm" type="button" data-action="check-updates">${icon('refresh', 13)} 检查更新</button>
          ${
            counts.updates
              ? `<button class="btn btn-sm btn-warn" type="button" data-action="update-all">${icon('download', 13)} 全部更新</button>`
              : ''
          }
        </div>
      </div>
      <div class="manifest">
        <div class="manifest-head">
          <span>插件</span>
          <span class="col-version">版本</span>
          <span class="col-source">来源</span>
          <span class="col-status">状态</span>
          <span class="col-actions">操作</span>
        </div>
        <div id="installed-rows">${rows}</div>
        <div class="list-empty" id="installed-empty" hidden>没有符合当前筛选的插件。</div>
      </div>`;
  }

  view.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div class="page-title">
          <h1>已安装插件</h1>
          ${hasAddons ? `<span class="page-count">${stats.visible} 个插件 · ${stats.folders} 个文件夹</span>` : ''}
        </div>
        <div class="head-actions">
          ${clientSelectHtml(clients)}
          <button class="btn" type="button" data-action="install-local" title="从已下载的 ZIP 安装">${icon(
            'upload',
            15,
          )} 安装本地包</button>
          <button class="btn btn-primary" type="button" data-action="goto-search">${icon('search', 15)} 搜索插件</button>
        </div>
      </header>
      <div class="page-scroll">${body}</div>
    </div>`;
  hydrateIcons(view);
  if (hasAddons) applyInstalledFilter();
}

function addonRow(addon) {
  const update = addon.update?.status === 'update';
  const rowState = update
    ? 'update'
    : addon.mixed
      ? 'mixed'
      : addon.enabled
        ? 'enabled'
        : 'disabled';
  const lang = addon.language || '';
  const nameTags = [
    languageTag(lang),
    addon.isLibrary ? '<span class="tag tag-plain">库</span>' : '',
    addon.managed?.pinned ? `<span class="tag tag-gold">${'固定'}</span>` : '',
  ]
    .filter(Boolean)
    .join('');
  const metaParts = [
    addon.baseFolder,
    addon.folderCount > 1 ? `共 ${addon.folderCount} 个文件夹` : '',
    addon.author || '',
  ].filter(Boolean);
  const statusText = addon.mixed ? '部分启用' : addon.enabled ? '已启用' : '已停用';
  const statusClass = update
    ? 'update'
    : addon.mixed
      ? 'mixed'
      : addon.enabled
        ? 'enabled'
        : 'disabled';
  const sourceCell = addon.source ? sourceTag(addon.source) : muted('本地');
  const toggleLabel = addon.mixed ? '全部停用' : addon.enabled ? '停用' : '启用';
  const avatarImage = safeImage(addon.icon);

  return `
    <div class="addon-row" data-state="${rowState}" data-name="${esc(
      `${addon.name} ${addon.baseFolder} ${addon.author || ''} ${sourceLabel(addon.source)}`.toLowerCase(),
    )}" data-enabled="${addon.enabled ? '1' : '0'}" data-library="${addon.isLibrary ? '1' : '0'}" data-update="${
      update ? '1' : '0'
    }">
      <div class="addon-main" data-action="open-local" data-folder="${esc(addon.baseFolder)}">
        <div class="addon-avatar ${addon.enabled ? '' : 'is-disabled'}">${
          avatarImage ? `<img src="${avatarImage}" alt="" loading="lazy" />` : esc(initial(addon.name))
        }</div>
        <div class="addon-copy">
          <div class="addon-name">
            <span class="name-text">${esc(addon.name)}</span>
            ${nameTags}
          </div>
          <div class="addon-meta">
            ${metaParts
              .map((part, index) =>
                index === 0
                  ? `<span class="meta-text mono">${esc(part)}</span>`
                  : `<span class="dot"></span><span class="meta-text">${esc(part)}</span>`,
              )
              .join('')}
          </div>
          <div class="mobile-meta">
            <span class="mono">${esc(addon.version || '未标版本')}</span>
            <span class="dot"></span>
            <span>${addon.source ? esc(sourceLabel(addon.source)) : '本地'}</span>
            <span class="dot"></span>
            <span>${statusText}</span>
          </div>
        </div>
      </div>
      <div class="addon-version">
        <span class="version-text" title="${esc(addon.version || '')}">${esc(addon.version || '—')}</span>
        ${update ? `<span class="version-next">→ ${esc(addon.update?.remote?.version || '新版本')}</span>` : ''}
      </div>
      <div class="addon-source">${sourceCell}</div>
      <div class="addon-status"><span class="status-pill ${statusClass}">${statusText}</span></div>
      <div class="addon-actions">
        ${
          update
            ? `<button class="row-action gold" type="button" data-action="update-addon" data-folder="${esc(
                addon.baseFolder,
              )}">更新</button>`
            : ''
        }
        <button class="row-action" type="button" data-action="toggle-addon" data-folder="${esc(
          addon.baseFolder,
        )}" data-enabled="${addon.enabled ? '1' : '0'}" data-folders="${esc(
          (addon.folders || [addon.baseFolder]).join('|'),
        )}">${toggleLabel}</button>
        <button class="icon-btn" type="button" data-action="open-local" data-folder="${esc(
          addon.baseFolder,
        )}" aria-label="查看 ${esc(addon.name)}"><span>${icon('more', 16)}</span></button>
      </div>
    </div>`;
}

function applyInstalledFilter() {
  if (state.route !== 'installed' || !state.installed) return;
  const query = state.installedQuery.trim().toLowerCase();
  const filter = state.installedFilter;
  let visible = 0;
  for (const row of $$('#installed-rows .addon-row')) {
    const library = row.dataset.library === '1';
    const enabled = row.dataset.enabled === '1';
    const update = row.dataset.update === '1';
    let match = true;
    if (filter === 'libraries') {
      match = library;
    } else {
      if (library) match = false;
      if (filter === 'enabled') match = enabled;
      if (filter === 'disabled') match = !enabled;
      if (filter === 'updates') match = update;
    }
    if (match && query) match = row.dataset.name.includes(query);
    row.classList.toggle('is-hidden', !match);
    if (match) visible += 1;
  }
  const empty = $('#installed-empty');
  if (empty) empty.hidden = visible > 0;
  for (const chip of $$('[data-action="filter-installed"]')) {
    chip.classList.toggle('active', chip.dataset.filter === filter);
  }
}

async function switchClient(addonPath, flavor) {
  try {
    const data = await api('/api/select-client', { method: 'POST', body: { addonPath, flavor } });
    state.bootstrap.settings = data.settings;
    state.bootstrap.target = data.target;
    state.bootstrap.clients = data.clients;
    state.bootstrap.scan = data.scan;
    state.installed = null;
    state.search.items = [];
    state.search.loaded = false;
    state.search.hasMore = false;
    if (data.target?.flavor && browseVersions().some((entry) => entry.key === data.target.flavor)) {
      state.search.versionKey = data.target.flavor;
    }
    state.profilesLoaded = false;
    updateChrome();
    const client = (data.clients || []).find((entry) => entry.current);
    const label = `${FLAVOR_LABELS[client?.key || flavor] || '客户端'}${
      client?.versionShort ? ` · ${client.versionShort}` : ''
    }`;
    toast(`已切换到 ${label}`);
    if (state.route === 'settings') {
      renderSettings();
    } else if (state.route === 'search') {
      renderSearchPage();
      if (state.search.query) await loadSearch(false);
    } else {
      await loadInstalled(false);
    }
  } catch (error) {
    toast(error.message, 'error');
    if (state.route === 'installed') await loadInstalled(false);
  }
}

/* ------------------------------------------------------------------ */
/* addon actions                                                       */
/* ------------------------------------------------------------------ */

async function toggleAddon(folder, enabled, foldersCsv) {
  const folders = String(foldersCsv || folder)
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean);
  try {
    for (const item of folders) {
      await api(`/api/addons/${encodeURIComponent(item)}`, {
        method: 'PATCH',
        body: { enabled: !enabled },
      });
    }
    toast(enabled ? `已停用 ${folder}` : `已启用 ${folder}`);
    state.installed = null;
    await loadInstalled(false);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function checkUpdates() {
  try {
    const task = await api('/api/check-updates', { method: 'POST' });
    trackTask(task, {
      onDone: async () => {
        state.installed = null;
        if (state.route === 'installed') await loadInstalled(false);
      },
    });
    toast('正在检查插件更新', 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function updateAll() {
  try {
    const task = await api('/api/update-all', { method: 'POST' });
    trackTask(task, {
      onDone: async () => {
        state.installed = null;
        if (state.route === 'installed') await loadInstalled(false);
      },
    });
    toast('正在更新全部插件', 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function updateAddon(folder) {
  try {
    const task = await api('/api/update', { method: 'POST', body: { folder } });
    trackTask(task, {
      onDone: async () => {
        state.installed = null;
        if (state.route === 'installed') await loadInstalled(false);
      },
    });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function installAddon(source, id, name, button) {
  const restore = setButtonBusy(button, '开始安装…');
  try {
    const task = await api('/api/install', {
      method: 'POST',
      body: { source, id, name },
    });
    closeModal();
    trackTask(task, {
      onDone: async () => {
        state.installed = null;
        await refreshBootstrap();
        if (state.route === 'search') await loadSearch(false, { silent: true });
        if (state.route === 'installed') await loadInstalled(false);
      },
    });
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    restore();
  }
}

async function installLocalAddon() {
  if (!state.bootstrap?.target?.addonPath) {
    toast('先选择魔兽世界客户端，再安装本地插件包', 'error');
    navigate('#/settings');
    return;
  }
  try {
    const picked = await api('/api/dialog/file', {
      method: 'POST',
      body: {
        title: '选择已下载的插件压缩包（.zip / .addon）',
      },
    });
    if (picked.canceled) return;
    const task = await api('/api/install-local', {
      method: 'POST',
      body: { path: picked.path },
    });
    trackTask(task, {
      onDone: async () => {
        state.installed = null;
        await refreshBootstrap();
        if (state.route === 'installed') await loadInstalled(false);
        if (state.route === 'search') await loadSearch(false, { silent: true });
      },
    });
    toast('正在安装本地插件包', 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function backupAddon(folder) {
  try {
    await api(`/api/addons/${encodeURIComponent(folder)}/backup`, { method: 'POST' });
    toast('已创建插件备份');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function pinAddon(folder, pinned) {
  try {
    await api(`/api/addons/${encodeURIComponent(folder)}/pin`, {
      method: 'POST',
      body: { pinned },
    });
    toast(pinned ? '已固定版本，全部更新会跳过这个插件' : '已取消固定版本');
    state.installed = null;
    closeModal();
    await loadInstalled(false);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function uninstallAddon(folder, foldersCsv, name) {
  const ok = await confirmDialog({
    title: `卸载 ${name || folder}`,
    message: '会先自动备份整个插件包，再删除它的全部文件夹。WTF 里的角色配置不会删除。',
    confirmText: '卸载插件',
    danger: true,
  });
  if (!ok) return;
  try {
    const folders = String(foldersCsv || folder)
      .split('|')
      .map((value) => value.trim())
      .filter(Boolean);
    await api(`/api/addons/${encodeURIComponent(folder)}`, {
      method: 'DELETE',
      body: { backup: true, folders },
    });
    toast(`已卸载 ${name || folder}`);
    state.installed = null;
    closeModal();
    await loadInstalled(false);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function revealPath(target) {
  try {
    await api('/api/reveal', { method: 'POST', body: { path: target } });
    toast('已在资源管理器中打开', 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* modal: addon detail                                                 */
/* ------------------------------------------------------------------ */

function openLocalDetail(folder) {
  const addon = (state.installed?.addons || []).find(
    (entry) => entry.baseFolder.toLowerCase() === String(folder).toLowerCase(),
  );
  if (!addon) {
    toast('没有找到这个插件', 'error');
    return;
  }
  const folders = addon.folders || [addon.baseFolder];
  const body = `
    <div class="meta-grid">
      <div class="meta-cell"><span>版本</span><strong>${esc(addon.version || '未标注')}</strong></div>
      <div class="meta-cell"><span>作者</span><strong>${esc(addon.author || '未知')}</strong></div>
      <div class="meta-cell"><span>语言</span><strong>${
        addon.language === 'zh' ? '中文' : addon.language === 'en' ? '无中文' : '待检测'
      }</strong></div>
      <div class="meta-cell"><span>状态</span><strong>${
        addon.mixed ? '部分启用' : addon.enabled ? '已启用' : '已停用'
      }</strong></div>
      <div class="meta-cell"><span>TOC</span><strong>${esc(addon.tocFile || '—')}</strong></div>
      <div class="meta-cell"><span>Interface</span><strong>${esc(addon.interface || '—')}</strong></div>
      <div class="meta-cell"><span>文件夹</span><strong>${folders.length} 个</strong></div>
      <div class="meta-cell"><span>来源</span><strong>${
        addon.source ? sourceLabel(addon.source) : '本地'
      }</strong></div>
    </div>
    <div class="detail-section">
      <h3>${icon('folder', 13)} 插件目录</h3>
      <div class="path-box"><span class="path-text">${esc(addon.path)}</span></div>
    </div>
    <div class="detail-section">
      <h3>${icon('layers', 13)} 文件夹</h3>
      <div class="version-list">${folders
        .map(
          (item) =>
            `<div class="version-row"><span class="version-name">${esc(item)}</span><span class="version-date">${
              item.toLowerCase() === addon.baseFolder.toLowerCase() ? '主文件夹' : ''
            }</span></div>`,
        )
        .join('')}</div>
    </div>
    ${
      addon.notes
        ? `<div class="detail-section"><h3>${icon('info', 13)} 插件说明</h3><p>${esc(addon.notes)}</p></div>`
        : ''
    }
    <div class="local-detail-actions">
      <button class="btn btn-sm" type="button" data-action="addon-open" data-folder="${esc(addon.baseFolder)}">${icon(
        'folderOpen',
        14,
      )} 打开目录</button>
      <button class="btn btn-sm" type="button" data-action="addon-backup" data-folder="${esc(
        addon.baseFolder,
      )}">${icon('archive', 14)} 备份</button>
      ${
        addon.managed && SOURCES[addon.managed.source]
          ? `<button class="btn btn-sm" type="button" data-action="addon-pin" data-folder="${esc(
              addon.baseFolder,
            )}" data-pinned="${addon.managed.pinned ? '1' : '0'}">${icon('pin', 14)} ${
              addon.managed.pinned ? '取消固定' : '固定版本'
            }</button>`
          : ''
      }
      <button class="btn btn-sm" type="button" data-action="toggle-addon" data-folder="${esc(
        addon.baseFolder,
      )}" data-enabled="${addon.enabled ? '1' : '0'}" data-folders="${esc(folders.join('|'))}">${icon(
        'power',
        14,
      )} ${addon.mixed ? '全部停用' : addon.enabled ? '停用' : '启用'}</button>
      <button class="btn btn-sm btn-danger" type="button" data-action="addon-uninstall" data-folder="${esc(
        addon.baseFolder,
      )}" data-folders="${esc(folders.join('|'))}" data-name="${esc(addon.name)}">${icon(
        'trash',
        14,
      )} 卸载</button>
    </div>`;
  renderModal({
    title: addon.name,
    subtitle: esc(shortPath(addon.path, 90)),
    body,
    footer: `<button class="btn" type="button" data-action="close-modal">关闭</button>`,
    size: 'modal-wide',
  });
}

async function openRemoteDetail(source, id) {
  renderModal({
    title: '插件详情',
    body: `<div class="boot" style="min-height:180px"><span class="spinner"></span><p>正在读取插件信息…</p></div>`,
    footer: `<button class="btn" type="button" data-action="close-modal">关闭</button>`,
    size: 'modal-wide',
  });
  try {
    const item = await api(`/api/addon/${encodeURIComponent(source)}/${encodeURIComponent(id)}`);
    renderRemoteDetail(item);
  } catch (error) {
    toast(error.message, 'error');
    closeModal();
  }
}

function renderRemoteDetail(item) {
  const image = safeImage(item.icon);
  const screenshots = (item.screenshots || []).filter((url) => /^https?:\/\//i.test(url)).slice(0, 8);
  const versions = (item.versions || []).slice(0, 10);
  const installed = item.installed
    ? `<span class="tag tag-green">已安装${item.installed.version ? ` · ${esc(item.installed.version)}` : ''}</span>`
    : '';
  const body = `
    <div class="detail-hero">
      <div class="detail-icon">${image ? `<img src="${image}" alt="" />` : esc(initial(item.name))}</div>
      <div class="detail-copy">
        <div class="detail-tags">
          ${sourceTag(item.source)}
          ${languageTag(item.language)}
          ${supportedVersionTag(item)}
          ${installed}
          ${item.upstreamLabel ? `<span class="tag tag-plain">上游 · ${esc(item.upstreamLabel)}</span>` : ''}
        </div>
        <p class="result-summary-text" style="margin-top:8px">${esc(item.summary || item.description || '')}</p>
      </div>
    </div>
    <div class="meta-grid">
      <div class="meta-cell"><span>版本</span><strong>${esc(item.version || '未知')}</strong></div>
      <div class="meta-cell"><span>更新</span><strong>${esc(formatDate(item.updatedAt) || '未知')}</strong></div>
      <div class="meta-cell"><span>下载</span><strong>${item.downloads ? formatCount(item.downloads) : '—'}</strong></div>
      <div class="meta-cell"><span>作者</span><strong>${esc(item.author || '未知')}</strong></div>
    </div>
    ${
      supportedVersionList(item).length
        ? `<div class="detail-section"><h3>${icon('gamepad', 13)} 支持版本</h3>
            <div class="detail-tags">${supportedVersionList(item)
              .map(
                (entry) =>
                  `<span class="tag tag-version" title="${esc(entry.raw)}">${esc(entry.text)}</span>`,
              )
              .join('')}</div></div>`
        : ''
    }
    ${
      item.description && item.description !== item.summary
        ? `<div class="detail-section"><h3>${icon('info', 13)} 插件说明</h3><p>${esc(
            item.description,
          )}</p></div>`
        : ''
    }
    ${
      screenshots.length
        ? `<div class="detail-section"><h3>${icon('eye', 13)} 截图</h3>
            <div class="screenshot-grid">${screenshots
              .map((url) => `<img src="${esc(url)}" alt="" loading="lazy" />`)
              .join('')}</div></div>`
        : ''
    }
    ${
      versions.length
        ? `<div class="detail-section"><h3>${icon('clock', 13)} 版本记录</h3>
            <div class="version-list">${versions
              .map(
                (entry) => `
              <div class="version-row">
                <span class="version-name">${esc(entry.version || '未命名')}</span>
                ${entry.label ? `<span class="tag tag-plain">${esc(entry.label)}</span>` : ''}
                <span class="version-date">${esc(formatDate(entry.date))}${
                  entry.size ? ` · ${formatBytes(entry.size)}` : ''
                }</span>
              </div>`,
              )
              .join('')}</div></div>`
        : ''
    }`;
  const footLeft = [
    item.url
      ? `<button class="btn btn-sm btn-ghost" type="button" data-action="external" data-url="${esc(
          item.url,
        )}">${icon('external', 13)} 来源页面</button>`
      : '',
    item.officialUrl
      ? `<button class="btn btn-sm btn-ghost" type="button" data-action="external" data-url="${esc(
          item.officialUrl,
        )}">${icon('arrowUpRight', 13)} 上游官方</button>`
      : '',
  ].join('');
  renderModal({
    title: item.name || '插件详情',
    subtitle: `${esc(sourceLabel(item.source))}${item.author ? ` · ${esc(item.author)}` : ''}`,
    body,
    footer: `
      <div class="foot-left">${footLeft}</div>
      <button class="btn" type="button" data-action="close-modal">关闭</button>
      <button class="btn btn-primary" type="button" data-action="install" data-source="${esc(
        item.source,
      )}" data-id="${esc(item.id)}" data-name="${esc(item.name || '')}">${icon(
        'download',
        14,
      )} ${item.installed ? '重新安装' : '安装到插件目录'}</button>`,
    size: 'modal-wide',
  });
}

/* ------------------------------------------------------------------ */
/* search                                                              */
/* ------------------------------------------------------------------ */

let searchObserver = null;

function enabledSources() {
  return (state.bootstrap?.sources || []).filter(
    (source) => source.enabled && source.configured !== false,
  );
}

function sourceChipsHtml() {
  const enabled = enabledSources();
  const groupCounts = new Map((state.search.groups || []).map((group) => [group.id, group.count]));
  const total = (state.search.groups || []).reduce((sum, group) => sum + (group.count || 0), 0);
  const chips = [
    `<button class="chip ${state.search.source === 'all' ? 'active' : ''}" type="button" data-action="search-source" data-source="all">全部来源${
      state.search.loaded ? `<span class="chip-count">${total}</span>` : ''
    }</button>`,
  ];
  for (const source of enabled) {
    const meta = SOURCES[source.id] || { label: source.label };
    const count = groupCounts.get(source.id);
    chips.push(`<button class="chip ${state.search.source === source.id ? 'active' : ''}" type="button"
      data-action="search-source" data-source="${esc(source.id)}">${esc(meta.label)}${
        state.search.loaded && count !== undefined ? `<span class="chip-count">${count}</span>` : ''
      }</button>`);
  }
  return chips.join('');
}

function searchCategories() {
  const list = state.bootstrap?.categories;
  return Array.isArray(list) && list.length ? list : FALLBACK_CATEGORIES;
}

function categoryLabel(key) {
  return searchCategories().find((category) => category.key === key)?.label || '全部插件';
}

function sortLabel(key) {
  return SORT_OPTIONS.find((option) => option.key === key)?.label || '热度';
}

function browseVersions() {
  const list = state.bootstrap?.browseVersions;
  return Array.isArray(list) && list.length ? list : FALLBACK_VERSIONS;
}

function browseVersionEntry(key) {
  return browseVersions().find((item) => item.key === key) || browseVersions()[0];
}

function defaultBrowseVersion() {
  const client = currentClient();
  const candidates = [client?.key, state.bootstrap?.settings?.flavor, 'unlimited'];
  for (const candidate of candidates) {
    if (candidate && browseVersions().some((item) => item.key === candidate)) return candidate;
  }
  return browseVersions()[0]?.key || 'unlimited';
}

function browseControlsHtml() {
  const categories = searchCategories()
    .map(
      (category) =>
        `<option value="${esc(category.key)}" ${
          category.key === state.search.category ? 'selected' : ''
        }>${esc(category.label)}</option>`,
    )
    .join('');
  const sorts = SORT_OPTIONS.map(
    (option) =>
      `<option value="${esc(option.key)}" ${
        option.key === state.search.sort ? 'selected' : ''
      }>${esc(option.label)}</option>`,
  ).join('');
  const versions = browseVersions()
    .map(
      (version) =>
        `<option value="${esc(version.key)}" ${
          version.key === state.search.versionKey ? 'selected' : ''
        }>${esc(version.label)}</option>`,
    )
    .join('');
  return `<div class="browse-controls">
    <label class="select-control" title="浏览哪个魔兽版本">
      <span class="select-control-label">版本</span>
      <select id="search-version" aria-label="浏览版本">${versions}</select>
      <span class="select-control-chevron">${icon('chevronDown', 12)}</span>
    </label>
    <label class="select-control" title="按分类筛选">
      <span class="select-control-label">分类</span>
      <select id="search-category" aria-label="插件分类">${categories}</select>
      <span class="select-control-chevron">${icon('chevronDown', 12)}</span>
    </label>
    <label class="select-control" title="排序方式">
      <span class="select-control-label">排序</span>
      <select id="search-sort" aria-label="排序方式">${sorts}</select>
      <span class="select-control-chevron">${icon('chevronDown', 12)}</span>
    </label>
  </div>`;
}

function noSourcesHtml() {
  const sources = state.bootstrap?.sources || [];
  const enabled = sources.filter((source) => source.enabled);
  const waitingKey = enabled.filter((source) => source.configured === false);
  const message = waitingKey.length
    ? `已启用 ${waitingKey
        .map((source) => SOURCES[source.id]?.label || source.label)
        .join('、')}，但还需要在设置里填写 API Key。`
    : '至少启用一个插件来源，才能浏览和搜索插件。';
  return `<div class="empty" style="margin-top:6vh">
    <div class="empty-visual">${icon('wifiOff', 24)}</div>
    <h2>还没有可用的插件来源</h2>
    <p>${esc(message)}</p>
    <div class="empty-actions"><button class="btn btn-primary" type="button" data-action="goto-settings">${icon(
      'settings',
      15,
    )} 去设置来源</button></div>
  </div>`;
}

function searchSkeletonHtml() {
  return `<div class="skeleton-list">${Array.from({ length: 4 })
    .map(
      () => `<div class="skeleton-row">
        <div class="skeleton skeleton-avatar"></div>
        <div class="skeleton-copy"><div class="skeleton" style="width:40%"></div><div class="skeleton" style="width:72%"></div></div>
      </div>`,
    )
    .join('')}</div>`;
}

function renderSearchPage() {
  const view = $('#view');
  if (!state.search.versionKey) state.search.versionKey = defaultBrowseVersion();
  const client = currentClient();
  const targetLabel = client ? FLAVOR_LABELS[client.key] || client.label : '未选择客户端';
  const targetTitle = client
    ? `当前客户端：${targetLabel}${client.versionShort ? ` · ${client.versionShort}` : ''}`
    : '还没有选择安装目标客户端';
  const enabled = enabledSources();
  view.innerHTML = `
    <div class="page">
      <header class="page-head" style="flex-direction:column;align-items:stretch;gap:0">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div class="page-title"><h1>搜索插件</h1></div>
          <div class="head-actions" style="padding-top:0">
            <span class="search-context" style="margin:0">
              <span>安装到</span>
              <button class="client-chip" type="button" data-action="goto-settings" title="${esc(
                targetTitle,
              )}">${icon('gamepad', 12)} ${esc(targetLabel)}</button>
            </span>
          </div>
        </div>
        <form class="search-form" data-search-form>
          ${icon('search', 18)}
          <input id="search-input" type="search" name="q" value="${esc(
            state.search.query,
          )}" placeholder="搜索插件、作者或关键词，留空则浏览插件列表" autocomplete="off" spellcheck="false" />
          <button class="btn btn-primary" type="submit">搜索</button>
        </form>
        <div class="search-filters">
          <div class="source-row" id="source-chips">${sourceChipsHtml()}</div>
          ${browseControlsHtml()}
        </div>
      </header>
      <div class="page-scroll" id="search-results">${
        enabled.length ? searchSkeletonHtml() : noSourcesHtml()
      }</div>
      <button class="back-to-top" id="search-back-top" type="button" data-action="search-top" hidden>
        ${icon('arrowUp', 14)}<span>返回顶部</span>
      </button>
    </div>`;
  hydrateIcons(view);
  bindSearchTopButton();
  if (state.search.loaded && enabled.length) renderSearchResults();
}

function updateSourceChips() {
  const holder = $('#source-chips');
  if (holder) {
    holder.innerHTML = sourceChipsHtml();
    hydrateIcons(holder);
  }
}

function writeSearchHash() {
  const params = new URLSearchParams();
  if (state.search.query.trim()) params.set('q', state.search.query.trim());
  if (state.search.source !== 'all') params.set('source', state.search.source);
  if (state.search.category !== 'all') params.set('category', state.search.category);
  if (state.search.sort !== 'popular') params.set('sort', state.search.sort);
  const currentKey = currentClient()?.key || state.bootstrap?.settings?.flavor;
  if (state.search.versionKey && state.search.versionKey !== currentKey) {
    params.set('version', state.search.versionKey);
  }
  const text = params.toString();
  history.replaceState(null, '', `#/search${text ? `?${text}` : ''}`);
}

function searchRequestUrl(append) {
  return {
    q: state.search.query.trim(),
    source: state.search.source,
    category: state.search.category,
    sort: state.search.sort,
    version: browseVersionEntry(state.search.versionKey).wclbox,
    page: append ? state.search.page + 1 : 1,
  };
}

async function loadSearch(append = false, options = {}) {
  if (
    state.search.source !== 'all' &&
    !enabledSources().some((source) => source.id === state.search.source)
  ) {
    state.search.source = 'all';
    updateSourceChips();
  }
  if (!state.search.versionKey || !browseVersions().some((entry) => entry.key === state.search.versionKey)) {
    state.search.versionKey = defaultBrowseVersion();
  }
  const enabled = enabledSources();
  const holder = $('#search-results');
  if (!enabled.length) {
    state.search.loading = false;
    state.search.loaded = true;
    state.search.items = [];
    state.search.error = '';
    if (holder) {
      holder.innerHTML = noSourcesHtml();
      hydrateIcons(holder);
    }
    return;
  }
  const token = ++state.search.req;
  state.search.loading = true;
  state.search.error = '';
  state.search.appendError = '';
  if (!append) {
    if (searchObserver) {
      searchObserver.disconnect();
      searchObserver = null;
    }
    state.search.items = [];
    state.search.page = 1;
    state.search.hasMore = false;
    if (holder) {
      holder.scrollTop = 0;
      holder.innerHTML = searchSkeletonHtml();
    }
  } else {
    updateSearchFooter();
  }
  try {
    const data = await api('/api/search', { query: searchRequestUrl(append) });
    if (token !== state.search.req) return;
    const incoming = data.items || [];
    const merged = append ? mergeSearchItems(state.search.items, incoming) : incoming;
    const grew = merged.length > state.search.items.length || !append;
    state.search.items = merged;
    state.search.groups = data.groups || [];
    state.search.total = data.total || 0;
    state.search.page = data.page || (append ? state.search.page + 1 : 1);
    state.search.hasMore = Boolean(data.hasMore) && grew;
    state.search.loaded = true;
    state.search.loading = false;
    state.search.source = data.source || state.search.source;
    state.search.category = data.category || state.search.category;
    state.search.sort = data.sort || state.search.sort;
    if (data.client) {
      state.bootstrap.target = data.client;
    }
    const scrollTop = holder?.scrollTop || 0;
    renderSearchResults();
    if (holder) holder.scrollTop = scrollTop;
    updateSourceChips();
    writeSearchHash();
  } catch (error) {
    if (token !== state.search.req) return;
    state.search.loading = false;
    state.search.loaded = true;
    if (append) {
      state.search.appendError = error.message;
      const scrollTop = holder?.scrollTop || 0;
      renderSearchResults();
      if (holder) holder.scrollTop = scrollTop;
    } else {
      state.search.error = error.message;
      renderSearchResults();
    }
  } finally {
    if (token === state.search.req && !options.silent) {
      const input = $('#search-input');
      if (input && document.activeElement !== input) input.value = state.search.query;
    }
  }
}

function mergeSearchItems(existing, incoming) {
  const seen = new Set(existing.map((item) => `${item.source}:${item.id}`));
  const merged = existing.slice();
  for (const item of incoming) {
    const key = `${item.source}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function compareSearchSort(a, b) {
  if (state.search.sort === 'updated') {
    const diff = new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    if (diff) return diff;
  } else if (state.search.sort === 'name') {
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  } else {
    const diff = (b.downloads || b.favorites || 0) - (a.downloads || a.favorites || 0);
    if (diff) return diff;
  }
  return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
}

function sortForMode(items) {
  return items.slice().sort(compareSearchSort);
}

function searchSections() {
  const exact = state.search.items
    .filter((item) => item.match === 'exact')
    .slice()
    .sort((a, b) => (a.matchRank || 0) - (b.matchRank || 0) || compareSearchSort(a, b));
  const fuzzy = state.search.items
    .filter((item) => item.match !== 'exact')
    .slice()
    .sort((a, b) => compareSearchSort(a, b));
  return { exact, fuzzy };
}

function updateBackToTopButton() {
  const holder = $('#search-results');
  const button = $('#search-back-top');
  if (!holder || !button) return;
  button.hidden = holder.scrollTop <= 480;
  if (!button.hidden) positionBackToTop();
}

function positionBackToTop() {
  const button = $('#search-back-top');
  if (!button || button.hidden) return;
  const dock = $('#task-dock');
  const count = dock ? dock.children.length : 0;
  if (!count) {
    button.style.bottom = '';
    return;
  }
  const height = dock.getBoundingClientRect().height;
  const offset = Math.round(18 + height + 14);
  button.style.bottom = `${Math.max(24, Math.min(window.innerHeight - 90, offset))}px`;
}

function bindSearchTopButton() {
  if (state.search.scrollCleanup) {
    state.search.scrollCleanup();
    state.search.scrollCleanup = null;
  }
  const holder = $('#search-results');
  const button = $('#search-back-top');
  if (!holder || !button) return;
  const onScroll = () => {
    button.hidden = holder.scrollTop <= 480;
    if (!button.hidden) positionBackToTop();
  };
  holder.addEventListener('scroll', onScroll, { passive: true });
  state.search.scrollCleanup = () => holder.removeEventListener('scroll', onScroll);
  onScroll();
}

function sourceHintHtml() {
  if (state.search.query.trim() || enabledSources().length !== 1) return '';
  const source = enabledSources()[0];
  return `<div class="banner">${icon('info', 15)}<div>当前只启用了 1 个来源（${esc(
    SOURCES[source.id]?.label || source.label,
  )}），浏览列表会比较少。<button class="row-action" type="button" data-action="goto-settings">启用更多来源</button></div></div>`;
}

function renderSearchResults() {
  const holder = $('#search-results');
  if (!holder) return;
  if (!enabledSources().length) {
    holder.innerHTML = noSourcesHtml();
    hydrateIcons(holder);
    return;
  }
  if (state.search.loading && !state.search.items.length) {
    holder.innerHTML = searchSkeletonHtml();
    return;
  }
  if (state.search.error && !state.search.items.length) {
    holder.innerHTML = `<div class="banner banner-error">${icon('alert', 15)}<div><strong>搜索失败。</strong> ${esc(
      state.search.error,
    )}</div></div>
    <div class="empty" style="margin-top:3vh">
      <div class="empty-visual">${icon('wifiOff', 24)}</div>
      <h2>没有拿到结果</h2>
      <p>检查网络或插件来源设置后重试。也可以换一个更短的关键词。</p>
      <div class="empty-actions"><button class="btn btn-primary" type="button" data-action="retry-search">${
        icon('refresh', 15)
      } 重新搜索</button>
      <button class="btn" type="button" data-action="goto-settings">来源设置</button></div>
    </div>`;
    hydrateIcons(holder);
    return;
  }
  const failed = (state.search.groups || []).filter((group) => !group.ok);
  const failedHtml = failed.length
    ? `<div class="banner" style="margin-bottom:10px">${icon('alert', 15)}<div>${failed
        .map((group) => `<strong>${esc(group.label)}</strong>：${esc(group.error || '加载失败')}`)
        .join('；')}。其他来源的结果仍然可用。</div></div>`
    : '';
  const browse = browseVersionEntry(state.search.versionKey);
  const installTarget = currentClient();
  const installLabel = installTarget
    ? FLAVOR_LABELS[installTarget.key] || installTarget.label || '当前客户端'
    : '';
  const browseNoticeLines = [];
  if (installTarget && browse && installTarget.key !== browse.key) {
    browseNoticeLines.push(
      `正在浏览 <strong>${esc(browse.label)}</strong> 的插件；安装仍会写入当前客户端 <strong>${esc(
        installLabel,
      )}</strong>。要安装到对应版本，请先在「已安装」页切换客户端。`,
    );
  }
  const browseNoticeHtml = browseNoticeLines.length
    ? `<div class="banner" style="margin-bottom:10px">${icon('info', 15)}<div>${browseNoticeLines
        .map((line) => `<div>${line}</div>`)
        .join('')}</div></div>`
    : '';
  if (!state.search.items.length) {
    const isQuery = Boolean(state.search.query.trim());
    holder.innerHTML = `${sourceHintHtml()}${failedHtml}${browseNoticeHtml}<div class="empty" style="margin-top:6vh">
      <div class="empty-visual">${icon('search', 24)}</div>
      <h2>${isQuery ? `没有找到“${esc(state.search.query)}”` : '这个分类下还没有插件'}</h2>
      <p>${
        isQuery
          ? '可以试试插件的英文原名，或换一个更短的关键词，或者把分类切回全部插件。'
          : '可以切换分类或来源，也可以换一个关键词搜索。'
      }</p>
      <div class="empty-actions">
        <button class="btn" type="button" data-action="reset-search">${icon('rotateCcw', 14)} 重置筛选</button>
        <button class="btn" type="button" data-action="goto-settings">来源设置</button>
      </div>
    </div>`;
    hydrateIcons(holder);
    return;
  }
  const isQuery = Boolean(state.search.query.trim());
  const { exact, fuzzy } = searchSections();
  const sorted = sortForMode(state.search.items);
  const totalLoaded = state.search.items.length;
  const summary = `<div class="result-summary">
      <span>已加载 <strong>${totalLoaded}</strong> 个${isQuery ? '结果' : '插件'}</span>
      ${
        isQuery
          ? `<span class="dot"></span><span>精确 <strong>${exact.length}</strong></span>
             <span class="dot"></span><span>相似 <strong>${fuzzy.length}</strong></span>`
          : `<span class="dot"></span><span>${esc(categoryLabel(state.search.category))}</span>
             <span class="dot"></span><span>按${esc(sortLabel(state.search.sort))}排序</span>`
      }
      ${
        state.search.total > totalLoaded
          ? `<span class="dot"></span><span>来源共约 ${formatCount(state.search.total)} 个</span>`
          : ''
      }
    </div>`;
  let sections = '';
  if (isQuery) {
    const exactHtml = `
      <section class="result-section">
        <div class="result-section-head">
          <h2>精确匹配 <span class="section-count">${exact.length}</span></h2>
          <span class="section-hint">名称或作者包含“${esc(state.search.query)}”</span>
        </div>
        ${
          exact.length
            ? `<div class="result-list">${exact.map((item) => resultCard(item)).join('')}</div>`
            : `<div class="subtle-empty">没有名称精确匹配的插件，下面是相近的结果。</div>`
        }
      </section>`;
    const fuzzyHtml = fuzzy.length
      ? `<section class="result-section">
          <div class="result-section-head">
            <h2>相似结果 <span class="section-count">${fuzzy.length}</span></h2>
            <span class="section-hint">名称相近，或介绍中提到关键词</span>
          </div>
          <div class="result-list">${fuzzy.map((item) => resultCard(item)).join('')}</div>
        </section>`
      : '';
    sections = exactHtml + fuzzyHtml;
  } else {
    sections = `
      <section class="result-section">
        <div class="result-section-head">
          <h2>${esc(categoryLabel(state.search.category))} <span class="section-count">${totalLoaded}</span></h2>
          <span class="section-hint">按${esc(sortLabel(state.search.sort))}排序 · 共 ${enabledSources().length} 个来源</span>
        </div>
        <div class="result-list">${sorted.map((item) => resultCard(item)).join('')}</div>
      </section>`;
  }
  const moreHtml = state.search.hasMore
    ? `<div class="load-more" id="search-sentinel">
        <span class="spinner sentinel-spinner" style="width:12px;height:12px" ${
          state.search.loading ? '' : 'hidden'
        }></span>
        <span class="sentinel-label">${
          state.search.appendError
            ? '加载失败'
            : state.search.loading
              ? '正在加载更多…'
              : '继续下滑自动加载更多'
        }</span>
        ${
          state.search.appendError
            ? `<span class="sentinel-error">${esc(
                state.search.appendError,
              )}</span><button class="btn btn-sm" type="button" data-action="load-more">重试</button>`
            : ''
        }
        ${
          !('IntersectionObserver' in window) && !state.search.appendError
            ? '<button class="btn btn-sm" type="button" data-action="load-more">加载更多</button>'
            : ''
        }
      </div>`
    : state.search.items.length
      ? '<div class="list-end">已加载全部结果</div>'
      : '';
  holder.innerHTML = `${sourceHintHtml()}${failedHtml}${browseNoticeHtml}${summary}${sections}${moreHtml}`;
  hydrateIcons(holder);
  observeSearchSentinel();
  updateBackToTopButton();
}

function updateSearchFooter() {
  const sentinel = $('#search-sentinel');
  if (!sentinel) return;
  const spinner = sentinel.querySelector('.sentinel-spinner');
  const label = sentinel.querySelector('.sentinel-label');
  if (spinner) spinner.hidden = !state.search.loading;
  if (label) {
    label.textContent = state.search.appendError
      ? '加载失败'
      : state.search.loading
        ? '正在加载更多…'
        : '继续下滑自动加载更多';
  }
  sentinel.classList.toggle('is-loading', state.search.loading);
}

function observeSearchSentinel() {
  if (searchObserver) {
    searchObserver.disconnect();
    searchObserver = null;
  }
  if (!('IntersectionObserver' in window)) return;
  const holder = $('#search-results');
  const sentinel = $('#search-sentinel');
  if (!holder || !sentinel || !state.search.hasMore || state.search.appendError) return;
  searchObserver = new IntersectionObserver(
    (entries) => {
      if (
        entries.some((entry) => entry.isIntersecting) &&
        state.search.hasMore &&
        !state.search.loading &&
        !state.search.appendError
      ) {
        loadSearch(true).catch(() => {});
      }
    },
    { root: holder, rootMargin: '500px 0px', threshold: 0.01 },
  );
  searchObserver.observe(sentinel);
}

function resultCard(item) {
  const image = safeImage(item.icon);
  const installed = item.installed
    ? `<span class="tag tag-green">已安装</span>`
    : '';
  const meta = [
    item.version ? `<span class="mono">${esc(item.version)}</span>` : '',
    item.downloads ? `<span>${formatCount(item.downloads)} 下载</span>` : '',
    item.updatedAt ? `<span>${esc(formatRelative(item.updatedAt))}</span>` : '',
    item.author ? `<span>${esc(item.author)}</span>` : '',
  ]
    .filter(Boolean)
    .map((part) => `<span>${part}</span>`)
    .join('<span class="dot"></span>');
  return `
    <article class="result-card">
      <div class="result-icon">${image ? `<img src="${image}" alt="" loading="lazy" />` : esc(initial(item.name))}</div>
      <div class="result-body">
        <div class="result-title">
          <strong title="${esc(item.name)}">${esc(item.name)}</strong>
          ${sourceTag(item.source)}
          ${languageTag(item.language)}
          ${supportedVersionTag(item)}
          ${installed}
        </div>
        <p class="result-summary-text">${esc(item.summary || '暂无简介')}</p>
        <div class="result-meta">${meta}</div>
      </div>
      <div class="result-actions">
        <button class="btn btn-sm ${item.installed ? '' : 'btn-primary'}" type="button" data-action="install"
          data-source="${esc(item.source)}" data-id="${esc(item.id)}" data-name="${esc(item.name)}">
          ${icon('download', 13)} ${item.installed ? '重新安装' : '安装'}
        </button>
        <button class="btn btn-sm" type="button" data-action="detail" data-source="${esc(
          item.source,
        )}" data-id="${esc(item.id)}">详情</button>
      </div>
    </article>`;
}

function clearSearch() {
  state.search.query = '';
  state.search.page = 1;
  state.search.items = [];
  state.search.hasMore = false;
  state.search.loaded = false;
  const input = $('#search-input');
  if (input) input.value = '';
  writeSearchHash();
  loadSearch(false);
}

async function resetSearch() {
  state.search.query = '';
  state.search.source = 'all';
  state.search.category = 'all';
  state.search.sort = 'popular';
  state.search.page = 1;
  state.search.items = [];
  state.search.hasMore = false;
  state.search.loaded = false;
  writeSearchHash();
  renderSearchPage();
  await loadSearch(false);
}

/* ------------------------------------------------------------------ */
/* backup and profiles                                                 */
/* ------------------------------------------------------------------ */

async function loadBackupPage(force = false) {
  const view = $('#view');
  if (!state.profilesLoaded || !state.backupsLoaded) {
    view.innerHTML = `<div class="boot"><span class="spinner"></span><p>正在读取备份记录…</p></div>`;
  }
  try {
    const requests = [];
    if (force || !state.profilesLoaded) requests.push(api('/api/profiles').then((data) => data.profiles || []));
    if (force || !state.backupsLoaded) requests.push(api('/api/backups'));
    const [profiles, backups] = await Promise.all(requests);
    if (profiles) state.profiles = profiles;
    if (backups) state.backups = backups;
    state.profilesLoaded = true;
    state.backupsLoaded = true;
  } catch (error) {
    renderFatal(error.message);
    return;
  }
  renderBackupPage();
}

function renderBackupPage() {
  const view = $('#view');
  const profiles = state.profiles || [];
  const backups = state.backups || [];
  const snapshotHtml = profiles.length
    ? `<div class="snapshot-list">${profiles.map((profile) => snapshotRow(profile)).join('')}</div>`
    : `<div class="empty" style="margin:22px auto 26px;max-width:420px">
        <div class="empty-visual">${icon('archive', 22)}</div>
        <h2>还没有配置快照</h2>
        <p>把当前客户端的插件列表、插件文件和角色配置打包保存。换电脑后导入这个文件，就能快速配齐。</p>
        <div class="empty-actions"><button class="btn btn-primary" type="button" data-action="save-profile-open">${icon(
          'plus',
          15,
        )} 保存当前配置</button></div>
      </div>`;
  const backupHtml = backups.length
    ? backups.map((backup) => backupRow(backup)).join('')
    : `<div class="subtle-empty">还没有版本备份。覆盖安装、更新或卸载插件前会自动创建。</div>`;

  view.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div class="page-title"><h1>备份与迁移</h1></div>
        <div class="head-actions">
          <button class="btn" type="button" data-action="import-profile">${icon('upload', 15)} 导入快照</button>
          <button class="btn btn-primary" type="button" data-action="save-profile-open">${icon('plus', 15)} 保存当前配置</button>
        </div>
      </header>
      <div class="page-scroll">
        <div class="content-column">
          <section class="stack-section">
            <div class="section-intro">
              <div>
                <h2>我的配置快照</h2>
                <p>记录装了哪些插件，可选带上插件文件和 WTF 角色配置。在其他电脑导入后恢复，不必一个个重装。</p>
              </div>
            </div>
            ${snapshotHtml}
          </section>

          <section class="stack-section">
            <div class="section-intro">
              <div>
                <h2>版本备份</h2>
                <p>覆盖安装、更新和卸载前的旧版本。恢复前会先备份当前版本。</p>
              </div>
            </div>
            <div class="card"><div class="card-body tight">${backupHtml}</div></div>
          </section>
        </div>
      </div>
    </div>`;
  hydrateIcons(view);
}

function snapshotRow(profile) {
  const stats = profile.stats || {};
  const includes = profile.includes || {};
  const client = profile.client || {};
  return `
    <div class="snapshot">
      <div class="snapshot-icon">${icon('archive', 18)}</div>
      <div class="snapshot-body">
        <div class="snapshot-title">
          ${esc(profile.name || '未命名快照')}
          ${profile.note ? `<span class="note">${esc(profile.note)}</span>` : ''}
        </div>
        <div class="snapshot-meta">
          <span class="mono">${esc(formatDate(profile.createdAt, true))}</span>
          <span class="dot"></span>
          <span>${stats.addons || 0} 个插件 / ${stats.folders || 0} 个文件夹</span>
          <span class="dot"></span>
          <span>${formatBytes(profile.size)}</span>
          ${
            client.label
              ? `<span class="dot"></span><span>${esc(client.label)}${
                  client.version ? ` · ${esc(String(client.version).split('.').slice(0, 2).join('.'))}` : ''
                }</span>`
              : ''
          }
        </div>
        <div class="snapshot-badges">
          ${
            includes.addonFiles
              ? '<span class="tag tag-green">含插件文件</span>'
              : '<span class="tag tag-plain">仅清单</span>'
          }
          ${
            includes.config
              ? `<span class="tag tag-blue">含角色配置${
                  stats.configFiles ? ` · ${stats.configFiles} 个文件` : ''
                }</span>`
              : '<span class="tag tag-plain">不含角色配置</span>'
          }
        </div>
      </div>
      <div class="snapshot-actions">
        <button class="btn btn-sm" type="button" data-action="restore-profile" data-id="${esc(profile.id)}">${icon(
          'rotateCcw',
          13,
        )} 恢复</button>
        <button class="btn btn-sm btn-ghost" type="button" data-action="export-profile" data-id="${esc(
          profile.id,
        )}">${icon('download', 13)} 导出</button>
        <button class="icon-btn" type="button" data-action="delete-profile" data-id="${esc(
          profile.id,
        )}" title="删除快照" aria-label="删除快照">${icon('trash', 15)}</button>
      </div>
    </div>`;
}

function backupRow(backup) {
  const metadata = backup.metadata || {};
  const reason = BACKUP_REASONS[backup.reason] || backup.reason || '备份';
  return `
    <div class="backup-row">
      <div class="backup-row-copy">
        <strong>${esc(backup.folder || metadata.folder || metadata.remoteName || '插件备份')}</strong>
        <span>${esc(reason)} · ${esc(formatDate(backup.createdAt, true))}${
          metadata.version ? ` · ${esc(metadata.version)}` : ''
        }</span>
      </div>
      <button class="btn btn-sm" type="button" data-action="restore-backup" data-id="${esc(backup.id)}">${icon(
        'rotateCcw',
        13,
      )} 恢复</button>
    </div>`;
}

function openSaveProfileModal() {
  const settings = state.bootstrap?.settings || {};
  const client = currentClient();
  const label = client
    ? `${FLAVOR_LABELS[client.key] || client.label}${client.versionShort ? ` · ${client.versionShort}` : ''}`
    : '配置';
  const defaultName = `${label} · ${formatDate(new Date().toISOString())}`;
  renderModal({
    title: '保存配置快照',
    subtitle: '把当前客户端的插件整理成一个可迁移的文件',
    body: `
      <form class="form-grid" data-profile-form>
        <label class="field">
          <span class="field-label">快照名称</span>
          <input class="input" name="name" value="${esc(defaultName)}" maxlength="80" autofocus />
        </label>
        <label class="field">
          <span class="field-label">备注（可选）</span>
          <input class="input" name="note" placeholder="例如：开荒用、换电脑前" maxlength="200" />
        </label>
        <label class="check-row">
          <input type="checkbox" name="includeFiles" ${settings.profileIncludeFiles !== false ? 'checked' : ''} />
          <span class="check-row-copy">
            <strong>包含插件文件</strong>
            <span>把插件文件夹一起打包，恢复时不依赖在线来源，整体体积会大一些。</span>
          </span>
        </label>
        <label class="check-row">
          <input type="checkbox" name="includeConfig" ${settings.profileIncludeConfig !== false ? 'checked' : ''} />
          <span class="check-row-copy">
            <strong>包含角色配置（WTF / SavedVariables）</strong>
            <span>插件设置、配置文件和角色数据。换环境恢复时，插件会像原来一样配置好。</span>
          </span>
        </label>
        <label class="check-row" data-all-config-row style="${
          settings.profileIncludeConfig === false ? 'opacity:0.45' : ''
        }">
          <input type="checkbox" name="includeAllConfig" checked ${
            settings.profileIncludeConfig === false ? 'disabled' : ''
          } />
          <span class="check-row-copy">
            <strong>包含所有角色的 SavedVariables</strong>
            <span>关闭后只保存与已安装插件相关的配置文件。</span>
          </span>
        </label>
        <p class="field-hint">快照可能包含角色数据，分享给他人前请确认内容。</p>
      </form>`,
    footer: `
      <button class="btn" type="button" data-action="close-modal">取消</button>
      <button class="btn btn-primary" type="button" data-action="create-profile">保存快照</button>`,
  });
}

async function createProfileFromModal() {
  const form = $('[data-profile-form]');
  if (!form) return;
  const button = $('[data-action="create-profile"]');
  const restore = setButtonBusy(button, '正在打包…');
  const data = new FormData(form);
  try {
    const profile = await api('/api/profiles', {
      method: 'POST',
      body: {
        name: String(data.get('name') || '').trim(),
        note: String(data.get('note') || '').trim(),
        includeFiles: data.get('includeFiles') === 'on',
        includeConfig: data.get('includeConfig') === 'on',
        includeAllConfig: data.get('includeAllConfig') === 'on',
      },
    });
    closeModal();
    toast(`已保存快照「${profile.name}」`);
    state.profilesLoaded = false;
    if (state.route === 'backup') await loadBackupPage(true);
  } catch (error) {
    toast(error.message, 'error');
    restore();
  }
}

async function openRestoreProfileModal(id) {
  renderModal({
    title: '准备恢复配置',
    body: `<div class="boot" style="min-height:180px"><span class="spinner"></span><p>正在比对本地插件…</p></div>`,
    footer: `<button class="btn" type="button" data-action="close-modal">取消</button>`,
    size: 'modal-wide',
  });
  try {
    const preview = await api('/api/profiles/preview', { method: 'POST', body: { id } });
    const summary = preview.summary || {};
    const manifest = preview.manifest || {};
    const configFiles = manifest.config?.files || [];
    const warnings = preview.warnings || [];
    const entries = preview.entries || [];
    const body = `
      ${
        warnings.length
          ? `<div class="banner">${icon('alert', 15)}<div>${warnings.map((text) => esc(text)).join('<br />')}</div></div>`
          : ''
      }
      <div class="preview-summary">
        <strong>${summary.total || 0}</strong> 个插件
        <span>·</span> 已安装 <strong>${summary.installed || 0}</strong>
        <span>·</span> 待安装 <strong>${summary.missing || 0}</strong>
        <span>·</span> 角色配置 <strong>${summary.configFiles || 0}</strong> 个文件
        <span>·</span> ${esc(preview.name)}
      </div>
      ${
        entries.length
          ? `<div class="preview-addons">${entries
              .map(
                (entry) => `
            <div class="preview-addon">
              <span class="preview-addon-name">${esc(entry.name)} <span class="mono" style="color:var(--muted-2)">${esc(
                entry.version || '',
              )}</span></span>
              <span class="preview-addon-state">${
                entry.status === 'installed'
                  ? `已安装${entry.versionState === 'different' ? '（版本不同）' : ''}`
                  : entry.status === 'partial'
                    ? '部分文件夹存在'
                    : entry.canInstall
                      ? '待安装'
                      : '缺少文件'
              }</span>
            </div>`,
              )
              .join('')}</div>`
          : ''
      }
      <div class="form-grid" style="margin-top:14px">
        <label class="check-row">
          <input type="checkbox" id="restore-config" ${
            configFiles.length ? 'checked' : 'disabled'
          } ${configFiles.length ? '' : 'checked'} />
          <span class="check-row-copy">
            <strong>恢复角色配置</strong>
            <span>${
              configFiles.length
                ? `写回 ${configFiles.length} 个 SavedVariables 文件，现有文件会先备份。请先退出游戏。`
                : '这个快照没有包含角色配置。'
            }</span>
          </span>
        </label>
        <label class="check-row">
          <input type="checkbox" id="restore-overwrite" />
          <span class="check-row-copy">
            <strong>覆盖已安装的插件</strong>
            <span>不勾选时，已安装的插件会跳过；勾选后会先备份再替换。</span>
          </span>
        </label>
      </div>
      ${
        !state.bootstrap?.target?.addonPath
          ? `<div class="banner banner-error" style="margin-top:12px">${icon('alert', 15)}<div>还没有选择客户端，请先到设置里选择游戏目录。</div></div>`
          : ''
      }`;
    renderModal({
      title: `恢复「${preview.name || '配置快照'}」`,
      subtitle: esc(formatDate(preview.createdAt, true)),
      body,
      footer: `
        <div class="foot-left">恢复过程会显示在右下角任务卡片</div>
        <button class="btn" type="button" data-action="close-modal">取消</button>
        <button class="btn btn-primary" type="button" data-action="start-restore-profile" data-id="${esc(
          id,
        )}" ${state.bootstrap?.target?.addonPath ? '' : 'disabled'}>开始恢复</button>`,
      size: 'modal-wide',
    });
  } catch (error) {
    toast(error.message, 'error');
    closeModal();
  }
}

async function startRestoreProfile(id) {
  const restoreConfig = $('#restore-config')?.checked ?? true;
  const overwrite = $('#restore-overwrite')?.checked ?? false;
  const button = $('[data-action="start-restore-profile"]');
  const restore = setButtonBusy(button, '正在开始…');
  try {
    const task = await api(`/api/profiles/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      body: { restoreConfig, overwrite },
    });
    closeModal();
    state.installed = null;
    state.profilesLoaded = false;
    trackTask(task, {
      onDone: async () => {
        state.installed = null;
        await refreshBootstrap();
        if (state.route === 'backup') await loadBackupPage(true);
        if (state.route === 'installed') await loadInstalled(false);
      },
    });
  } catch (error) {
    toast(error.message, 'error');
    restore();
  }
}

async function exportProfile(id) {
  const profile = (state.profiles || []).find((entry) => entry.id === id);
  if (!profile) return;
  try {
    const picked = await api('/api/dialog/save', {
      method: 'POST',
      body: {
        title: '导出配置快照',
        defaultName: `${String(profile.name || 'wow-profile').replace(/[\\/:*?"<>|]/g, '-')}.wowpack`,
      },
    });
    if (picked.canceled) return;
    const result = await api(`/api/profiles/${encodeURIComponent(id)}/export`, {
      method: 'POST',
      body: { path: picked.path },
    });
    toast(`已导出到 ${result.path}`, 'success', 5000);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function importProfile() {
  try {
    const picked = await api('/api/dialog/file', {
      method: 'POST',
      body: { title: '选择配置快照（.wowpack）', defaultPath: state.bootstrap?.settings?.dataDir || '' },
    });
    if (picked.canceled) return;
    const profile = await api('/api/profiles/import', {
      method: 'POST',
      body: { path: picked.path },
    });
    toast(`已导入快照「${profile.name}」`);
    state.profilesLoaded = false;
    if (state.route === 'backup') await loadBackupPage(true);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function deleteProfile(id) {
  const profile = (state.profiles || []).find((entry) => entry.id === id);
  const ok = await confirmDialog({
    title: '删除快照',
    message: `确定删除「${profile?.name || id}」？已导出的文件不受影响。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('已删除快照');
    state.profilesLoaded = false;
    await loadBackupPage(true);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function restoreBackup(id) {
  const backup = (state.backups || []).find((entry) => entry.id === id);
  const ok = await confirmDialog({
    title: '恢复版本备份',
    message: `把「${backup?.folder || id}」恢复到插件目录？当前版本会先自动备份。请先退出游戏。`,
    confirmText: '恢复',
  });
  if (!ok) return;
  try {
    await api(`/api/backups/${encodeURIComponent(id)}/restore`, { method: 'POST', body: {} });
    toast('已恢复备份');
    state.installed = null;
    state.backupsLoaded = false;
    await loadBackupPage(true);
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function settingsCard({ title, iconName, description, body, foot = '' }) {
  return `
    <section class="card">
      <div class="card-head">
        <h2>${icon(iconName, 16)} ${esc(title)}</h2>
        <p>${description}</p>
      </div>
      <div class="card-body">${body}</div>
      ${foot ? `<div class="card-foot">${foot}</div>` : ''}
    </section>`;
}

function clientChoicesHtml(clients, target) {
  const unique = [];
  const seen = new Set();
  for (const client of clients || []) {
    if (!client?.addonPath || seen.has(client.addonPath)) continue;
    seen.add(client.addonPath);
    unique.push(client);
  }
  if (!unique.length) {
    return `<div class="subtle-empty">没有自动检测到魔兽世界客户端。可以选择游戏目录，或手动定位 Interface/AddOns。</div>`;
  }
  return unique
    .map((client) => {
      const active = Boolean(target?.addonPath && client.addonPath === target.addonPath);
      const label = FLAVOR_LABELS[client.key] || client.label || client.folder;
      return `
        <div class="client-choice ${active ? 'active' : ''}" role="button" tabindex="0"
          data-action="client-choice" data-addon-path="${esc(client.addonPath)}" data-flavor="${esc(client.key)}">
          <span class="client-choice-radio"></span>
          <span class="client-choice-copy">
            <span class="client-choice-title">
              ${esc(label)}
              ${client.versionShort ? `<span class="mono">${esc(client.versionShort)}</span>` : ''}
              ${active ? '<span class="tag tag-gold">当前</span>' : ''}
              ${
                client.exists === false
                  ? '<span class="tag tag-plain">插件目录待创建</span>'
                  : ''
              }
            </span>
            <span class="client-choice-path">${esc(client.addonPath)}</span>
          </span>
          <span class="client-choice-side">${client.addonCount ? `${client.addonCount} 个文件夹` : ''}</span>
        </div>`;
    })
    .join('');
}

function sourcesHtml() {
  const sources = state.bootstrap?.sources || [];
  return sources
    .map((source) => {
      const meta = SOURCES[source.id] || { label: source.label, short: source.id.slice(0, 2) };
      const needsKey = source.id === 'curseforge';
      return `
        <div class="source-item ${source.enabled ? 'enabled' : ''}">
          <span class="source-icon">${esc(meta.short || source.id.slice(0, 2))}</span>
          <span class="source-copy">
            <span class="source-title">
              ${esc(meta.label || source.label)}
              ${source.kind === 'official' ? '<span class="tag tag-plain">官方</span>' : ''}
              ${source.experimental ? '<span class="tag tag-plain">实验性</span>' : ''}
              ${
                needsKey
                  ? source.configured
                    ? '<span class="tag tag-green">Key 已配置</span>'
                    : '<span class="tag tag-amber">待配置 Key</span>'
                  : ''
              }
            </span>
            <span class="source-desc">${esc(source.description || '')}</span>
          </span>
          <span class="source-side">
            <button class="btn btn-sm btn-ghost" type="button" data-action="test-source" data-id="${esc(
              source.id,
            )}">测试</button>
            <button class="switch" type="button" role="switch" aria-checked="${
              source.enabled ? 'true' : 'false'
            }" data-action="toggle-source" data-id="${esc(source.id)}" aria-label="启用 ${esc(
              meta.label || source.label,
            )}"></button>
          </span>
        </div>
        ${
          needsKey && source.enabled
            ? state.bootstrap?.settings?.curseforgeApiKeySet
              ? `<div class="cf-key-box is-saved">
                  <div class="cf-key-saved">
                    <span class="cf-key-saved-icon">${icon('check', 15)}</span>
                    <span class="cf-key-saved-copy">
                      <strong>CurseForge Key 已保存</strong>
                      <span>Key 只保存在本机。需要更换时，先点「清除并更换」，再粘贴新的 Key。</span>
                      <span class="cf-key-mask mono">••••••••••••••••</span>
                    </span>
                    <span class="cf-key-saved-actions">
                      <button class="btn btn-sm" type="button" data-action="test-source" data-id="curseforge">${icon(
                        'refresh',
                        12,
                      )} 测试连接</button>
                      <button class="btn btn-sm btn-danger" type="button" data-action="clear-cf-key">清除并更换</button>
                    </span>
                  </div>
                </div>`
              : `<div class="cf-key-box">
                  <div class="cf-key-head">
                    <div class="cf-key-help">
                      <strong>${icon('key', 13)} 获取 CurseForge API Key</strong>
                      <span>打开控制台登录 → 点 Create API Key（或已有 Key 右侧的复制按钮）→ 回来粘贴 → 保存 Key → 点测试。</span>
                    </div>
                    <button class="btn btn-sm" type="button" data-action="external" data-url="${CF_APPLY_URL}">${icon(
                      'external',
                      13,
                    )} 申请 API Key</button>
                  </div>
                  <div class="cf-key-input">
                    <input class="input" id="cf-key" type="password" placeholder="粘贴 CurseForge API Key" autocomplete="off" spellcheck="false" />
                    <button class="btn btn-sm btn-primary" type="button" data-action="save-cf-key">保存 Key</button>
                  </div>
                </div>`
            : ''
        }`;
    })
    .join('');
}

function renderSettings() {
  const view = $('#view');
  const bootstrap = state.bootstrap || {};
  const settings = bootstrap.settings || {};
  const target = bootstrap.target || {};
  const clients = bootstrap.clients || [];
  const client = clients.find((entry) => entry.current) || currentClient();
  const flavor = client?.key || settings.flavor;
  const clientLabel = `${FLAVOR_LABELS[flavor] || flavor || '未选择'}`
    ? `${FLAVOR_LABELS[flavor] || flavor || '未选择'}${
        client?.versionShort ? ` · ${client.versionShort}` : ''
      }`
    : '未选择';
  const addonPath = target.addonPath || settings.addonPath || '';
  const dataDir = settings.dataDir || '';

  const gameCard = settingsCard({
    title: '游戏与插件目录',
    iconName: 'gamepad',
    description:
      '选中要管理的客户端，切换后「已安装」只显示这个版本的插件。新增的客户端会自动出现在这里。',
    body: `
      <div id="client-choices">${clientChoicesHtml(clients, target)}</div>
      <div class="field-row" style="margin-top:6px">
        <div class="field-row-copy">
          <strong>插件目录</strong>
          <span>${addonPath ? '安装、更新和备份都会写入这个目录。' : '还没有选择客户端。'}</span>
        </div>
        <div class="field-row-control">
          <button class="btn btn-sm" type="button" data-action="redetect">${icon('refresh', 13)} 重新检测</button>
          <button class="btn btn-sm" type="button" data-action="pick-client-folder">${icon(
            'folderOpen',
            13,
          )} 选择目录</button>
        </div>
      </div>
      ${
        addonPath
          ? `<div class="path-box" style="margin-top:10px">
              <span class="path-text">${esc(addonPath)}</span>
              <button class="icon-btn" type="button" data-action="reveal" data-path="${esc(
                addonPath,
              )}" title="在资源管理器中打开">${icon('folder', 15)}</button>
            </div>`
          : ''
      }`,
  });

  const sourceCard = settingsCard({
    title: '插件来源',
    iconName: 'globe',
    description: '按需启用。Tukui 免 Key；CurseForge 需要自己的 API Key；其他来源默认关闭，可在需要时打开。',
    body: sourcesHtml(),
    foot: `<span class="field-hint" style="margin-right:auto">启用或停用会立即保存</span>`,
  });

  const backupCard = settingsCard({
    title: '更新与备份',
    iconName: 'archive',
    description: '覆盖安装、更新和卸载前默认会备份旧版本。快照默认包含角色配置。',
    body: `
      <div class="field-row">
        <div class="field-row-copy">
          <strong>覆盖前自动备份</strong>
          <span>备份失败时会取消安装，避免原插件丢失。</span>
        </div>
        <div class="field-row-control">
          <button class="switch" type="button" role="switch" aria-checked="${
            settings.backupBeforeUpdate !== false ? 'true' : 'false'
          }" data-action="toggle-backup-before" aria-label="覆盖前自动备份"></button>
        </div>
      </div>
      <div class="field-row">
        <div class="field-row-copy">
          <strong>保留的版本备份数量</strong>
          <span>超过数量后自动清理最早的备份。</span>
        </div>
        <div class="field-row-control">
          <input class="input number-input" id="backup-limit" type="number" min="1" max="30" value="${
            settings.backupLimit || 8
          }" />
        </div>
      </div>
      <div class="field-row">
        <div class="field-row-copy">
          <strong>快照默认包含插件文件</strong>
          <span>关闭后快照只记录清单，恢复时需要从在线来源重新下载。</span>
        </div>
        <div class="field-row-control">
          <button class="switch" type="button" role="switch" aria-checked="${
            settings.profileIncludeFiles !== false ? 'true' : 'false'
          }" data-action="toggle-include-files" aria-label="快照默认包含插件文件"></button>
        </div>
      </div>
      <div class="field-row">
        <div class="field-row-copy">
          <strong>快照默认包含角色配置</strong>
          <span>读取 WTF 里的 SavedVariables，恢复时写回。</span>
        </div>
        <div class="field-row-control">
          <button class="switch" type="button" role="switch" aria-checked="${
            settings.profileIncludeConfig !== false ? 'true' : 'false'
          }" data-action="toggle-include-config" aria-label="快照默认包含角色配置"></button>
        </div>
      </div>`,
  });

  const aboutCard = settingsCard({
    title: '关于',
    iconName: 'info',
    description: '本地运行，不上传账号或插件数据。删除软件不会删除已经装进游戏的插件。',
    body: `
      <div class="field-row">
        <div class="field-row-copy">
          <strong>界面缩放</strong>
          <span>高分辨率屏幕建议 125% 或 150%；只影响管家界面。</span>
        </div>
        <div class="field-row-control">
          <select class="input" id="ui-scale" aria-label="界面缩放">
            ${[1, 1.1, 1.25, 1.5, 1.75]
              .map(
                (scale) =>
                  `<option value="${scale}" ${
                    Number(settings.uiScale || 1) === scale ? 'selected' : ''
                  }>${Math.round(scale * 100)}%</option>`,
              )
              .join('')}
          </select>
        </div>
      </div>
      <div class="about-grid">
        <div>版本 <strong>v${esc(settings.appVersion || '')}</strong></div>
        <div>当前客户端 <strong>${esc(clientLabel)}</strong></div>
        <div>数据目录 <strong>${esc(shortPath(dataDir, 42))}</strong></div>
        <div>快捷键 <strong>Ctrl K 搜索插件</strong></div>
      </div>
      <div class="path-box" style="margin-top:12px">
        <span class="path-text">${esc(dataDir)}</span>
        <button class="icon-btn" type="button" data-action="reveal" data-path="${esc(dataDir)}" title="在资源管理器中打开">${icon(
          'folder',
          15,
        )}</button>
      </div>`,
  });

  view.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div class="page-title"><h1>设置</h1></div>
      </header>
      <div class="page-scroll">
        <div class="content-column">
          ${gameCard}
          ${sourceCard}
          ${backupCard}
          ${aboutCard}
        </div>
      </div>
    </div>`;
  hydrateIcons(view);
}

async function patchSettings(patch) {
  const data = await api('/api/settings', { method: 'PUT', body: patch });
  if (state.bootstrap) {
    state.bootstrap.settings = { ...state.bootstrap.settings, ...data };
    if (data.target) state.bootstrap.target = data.target;
  }
  updateChrome();
  return data;
}

async function refreshBootstrap() {
  const data = await api('/api/bootstrap');
  state.bootstrap = data;
  updateChrome();
}

async function toggleSource(id) {
  const sources = { ...(state.bootstrap?.settings?.sources || {}) };
  sources[id] = !sources[id];
  try {
    await patchSettings({ sources });
    await refreshBootstrap();
    renderSettings();
    toast(sources[id] ? `已启用 ${SOURCES[id]?.label || id}` : `已停用 ${SOURCES[id]?.label || id}`);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function testSource(id, button) {
  const restore = setButtonBusy(button, '测试中…');
  try {
    const result = await api('/api/providers/test', { method: 'POST', body: { source: id } });
    toast(`${SOURCES[id]?.label || id} 连接正常${result.latency ? ` · ${result.latency} ms` : ''}`);
  } catch (error) {
    toast(`${SOURCES[id]?.label || id}：${error.message}`, 'error');
  } finally {
    restore();
  }
}

async function saveCurseforgeKey() {
  const input = $('#cf-key');
  const value = String(input?.value || '').trim();
  if (!value) {
    toast('先粘贴 CurseForge API Key', 'error');
    return;
  }
  try {
    await patchSettings({ curseforgeApiKey: value });
    await refreshBootstrap();
    renderSettings();
    toast('CurseForge Key 已保存');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function clearCurseforgeKey() {
  try {
    await patchSettings({ clearCurseforgeKey: true });
    await refreshBootstrap();
    renderSettings();
    toast('已清除 CurseForge Key，可以粘贴新的 Key');
    setTimeout(() => $('#cf-key')?.focus(), 60);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function pickClientFolder() {
  try {
    const picked = await api('/api/dialog/folder', {
      method: 'POST',
      body: {
        title: '选择 World of Warcraft 安装目录或客户端目录',
        defaultPath: state.bootstrap?.settings?.wowRoot || 'C:\\',
      },
    });
    if (picked.canceled) return;
    const result = await api('/api/resolve-folder', { method: 'POST', body: { path: picked.path } });
    const candidates = result.candidates || [];
    if (candidates.length === 1) {
      await switchClient(candidates[0].addonPath, candidates[0].flavor);
      return;
    }
    renderModal({
      title: '选择要管理的客户端',
      subtitle: esc(picked.path),
      body: `<div class="form-grid">${candidates
        .map(
          (candidate) => `
        <div class="client-choice" data-action="candidate-choice" data-addon-path="${esc(
          candidate.addonPath,
        )}" data-flavor="${esc(candidate.flavor)}">
          <span class="client-choice-radio"></span>
          <span class="client-choice-copy">
            <span class="client-choice-title">${esc(candidate.label || candidate.folder)}${
              candidate.versionShort ? `<span class="mono">${esc(candidate.versionShort)}</span>` : ''
            }</span>
            <span class="client-choice-path">${esc(candidate.addonPath)}</span>
          </span>
        </div>`,
        )
        .join('')}</div>`,
      footer: `<button class="btn" type="button" data-action="close-modal">取消</button>`,
    });
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* tasks                                                               */
/* ------------------------------------------------------------------ */

function trackTask(task, options = {}) {
  state.tasks.set(task.id, {
    ...task,
    callback: options.onDone,
    closed: false,
  });
  renderTaskDock();
  pollTask(task.id);
}

function closeTask(task) {
  if (!task) return;
  if (task.autoCloseTimer) clearTimeout(task.autoCloseTimer);
  task.autoCloseTimer = null;
  task.closed = true;
}

function scheduleTaskAutoClose(task) {
  if (!task || task.closed || task.status === 'running') return;
  if (task.autoCloseTimer) clearTimeout(task.autoCloseTimer);
  const seconds = task.status === 'error' ? 25 : task.status === 'partial' ? 15 : 8;
  task.autoCloseSeconds = seconds;
  task.autoCloseTimer = setTimeout(() => {
    if (!task.closed) {
      task.closed = true;
      task.autoCloseTimer = null;
      renderTaskDock();
    }
  }, seconds * 1000);
}

async function pollTask(id) {
  const task = state.tasks.get(id);
  if (!task || task.status !== 'running') return;
  try {
    const data = await api(`/api/tasks/${encodeURIComponent(id)}`);
    const current = state.tasks.get(id);
    if (!current) return;
    Object.assign(current, data);
    renderTaskDock();
    if (data.status === 'running') {
      setTimeout(() => pollTask(id), 800);
    } else if (!current.finished) {
      current.finished = true;
      const type = data.status === 'error' ? 'error' : data.status === 'partial' ? 'info' : 'success';
      const message =
        data.status === 'error'
          ? data.error || data.stage || '任务失败'
          : data.status === 'partial'
            ? data.error || '部分内容未能完成，详情见任务卡片'
            : `${data.title || '任务'}已完成`;
      toast(message, type, data.status === 'error' ? 5000 : 3400);
      if (typeof current.callback === 'function') {
        try {
          await current.callback(data);
        } catch {
          // ignore refresh failures
        }
      }
      scheduleTaskAutoClose(current);
    }
  } catch (error) {
    const current = state.tasks.get(id);
    if (current) {
      current.status = 'error';
      current.error = error.message;
      renderTaskDock();
      scheduleTaskAutoClose(current);
    }
  }
}

function renderTaskDock() {
  const dock = $('#task-dock');
  if (!dock) return;
  const tasks = Array.from(state.tasks.values()).filter((task) => !task.closed).slice(-3);
  dock.innerHTML = tasks
    .map((task) => {
      const statusClass =
        task.status === 'error' ? 'is-error' : task.status === 'success' ? 'is-success' : '';
      const running = task.status === 'running';
      const detail = task.error || task.detail || '';
      return `
      <div class="task-card ${statusClass}">
        <div class="task-head">
          ${running ? '<span class="spinner" style="width:13px;height:13px"></span>' : icon(
            task.status === 'error' ? 'xCircle' : task.status === 'partial' ? 'alert' : 'checkCircle',
            15,
          )}
          <span class="task-title">${esc(task.title || '任务')}</span>
          <button class="icon-btn" type="button" data-action="remove-task" data-id="${esc(
            task.id,
          )}" aria-label="关闭任务">${icon('x', 14)}</button>
        </div>
        <div class="task-stage">${esc(task.stage || '')}${
          task.progress ? ` · ${Math.round(task.progress)}%` : ''
        }</div>
        <div class="task-progress"><i style="width:${Math.max(0, Math.min(100, task.progress || 0))}%"></i></div>
        ${detail ? `<div class="task-detail">${esc(detail)}</div>` : ''}
        ${
          !running && task.autoCloseSeconds
            ? `<div class="task-auto">${task.autoCloseSeconds} 秒后自动关闭</div>`
            : ''
        }
      </div>`;
    })
    .join('');
  hydrateIcons(dock);
  positionBackToTop();
}

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

function renderFatal(message) {
  const view = $('#view');
  view.innerHTML = `<div class="page"><div class="page-scroll"><div class="empty">
    <div class="empty-visual">${icon('alert', 24)}</div>
    <h2>读取失败</h2>
    <p>${esc(message || '本地服务没有响应')}</p>
    <div class="empty-actions"><button class="btn btn-primary" type="button" data-action="retry-boot">${
      icon('refresh', 15)
    } 重试</button></div>
  </div></div></div>`;
  hydrateIcons(view);
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

async function handleAction(action, element) {
  switch (action) {
    case 'goto-search':
      navigate('#/search');
      setTimeout(() => $('#search-input')?.focus(), 60);
      break;
    case 'goto-settings':
      navigate('#/settings');
      break;
    case 'close-modal':
      closeModal();
      break;
    case 'confirm-ok':
      resolveConfirm(true);
      break;
    case 'confirm-cancel':
      resolveConfirm(false);
      break;
    case 'retry-boot':
      try {
        await loadBootstrap(true);
        await renderRoute();
      } catch (error) {
        renderFatal(error.message);
      }
      break;
    case 'refresh-installed':
      state.installed = null;
      await loadInstalled(true);
      break;
    case 'check-updates':
      await checkUpdates();
      break;
    case 'update-all':
      await updateAll();
      break;
    case 'update-addon':
      await updateAddon(element.dataset.folder);
      break;
    case 'toggle-addon':
      await toggleAddon(
        element.dataset.folder,
        element.dataset.enabled === '1',
        element.dataset.folders,
      );
      break;
    case 'open-local':
      openLocalDetail(element.dataset.folder);
      break;
    case 'addon-open':
      await revealPath(
        (state.installed?.addons || []).find(
          (entry) => entry.baseFolder === element.dataset.folder,
        )?.path || '',
      );
      break;
    case 'addon-backup':
      await backupAddon(element.dataset.folder);
      break;
    case 'addon-pin':
      await pinAddon(element.dataset.folder, element.dataset.pinned !== '1');
      break;
    case 'addon-uninstall':
      await uninstallAddon(element.dataset.folder, element.dataset.folders, element.dataset.name);
      break;
    case 'filter-installed':
      state.installedFilter = element.dataset.filter || 'all';
      applyInstalledFilter();
      break;
    case 'install':
      await installAddon(
        element.dataset.source,
        element.dataset.id,
        element.dataset.name,
        element,
      );
      break;
    case 'install-local':
      await installLocalAddon();
      break;
    case 'reset-search':
      await resetSearch();
      break;
    case 'search-top': {
      const holder = $('#search-results');
      if (holder) {
        holder.scrollTo({
          top: 0,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
      }
      break;
    }
    case 'detail':
      await openRemoteDetail(element.dataset.source, element.dataset.id);
      break;
    case 'external':
      openExternal(element.dataset.url);
      break;
    case 'search-source':
      state.search.source = element.dataset.source || 'all';
      updateSourceChips();
      await loadSearch(false);
      break;
    case 'load-more':
      await loadSearch(true);
      break;
    case 'retry-search':
      await loadSearch(false);
      break;
    case 'clear-search':
      clearSearch();
      break;
    case 'save-profile-open':
      openSaveProfileModal();
      break;
    case 'create-profile':
      await createProfileFromModal();
      break;
    case 'import-profile':
      await importProfile();
      break;
    case 'export-profile':
      await exportProfile(element.dataset.id);
      break;
    case 'restore-profile':
      await openRestoreProfileModal(element.dataset.id);
      break;
    case 'start-restore-profile':
      await startRestoreProfile(element.dataset.id);
      break;
    case 'delete-profile':
      await deleteProfile(element.dataset.id);
      break;
    case 'restore-backup':
      await restoreBackup(element.dataset.id);
      break;
    case 'client-choice':
    case 'candidate-choice':
      closeModal();
      await switchClient(element.dataset.addonPath, element.dataset.flavor);
      break;
    case 'pick-client-folder':
      await pickClientFolder();
      break;
    case 'redetect':
      try {
        const data = await api('/api/detect', { method: 'POST', body: {} });
        if (state.bootstrap) {
          state.bootstrap.installations = data.installations || state.bootstrap.installations;
          state.bootstrap.clients = data.clients || [];
          if (data.target) state.bootstrap.target = data.target;
        }
        renderSettings();
        toast(`检测到 ${(data.clients || []).length} 个客户端`, 'info');
      } catch (error) {
        toast(error.message, 'error');
      }
      break;
    case 'toggle-source':
      await toggleSource(element.dataset.id);
      break;
    case 'test-source':
      await testSource(element.dataset.id, element);
      break;
    case 'save-cf-key':
      await saveCurseforgeKey();
      break;
    case 'clear-cf-key':
      await clearCurseforgeKey();
      break;
    case 'toggle-backup-before':
      try {
        await patchSettings({ backupBeforeUpdate: element.getAttribute('aria-checked') !== 'true' });
        renderSettings();
      } catch (error) {
        toast(error.message, 'error');
      }
      break;
    case 'toggle-include-files':
      try {
        await patchSettings({ profileIncludeFiles: element.getAttribute('aria-checked') !== 'true' });
        renderSettings();
      } catch (error) {
        toast(error.message, 'error');
      }
      break;
    case 'toggle-include-config':
      try {
        await patchSettings({ profileIncludeConfig: element.getAttribute('aria-checked') !== 'true' });
        renderSettings();
      } catch (error) {
        toast(error.message, 'error');
      }
      break;
    case 'reveal':
      await revealPath(element.dataset.path);
      break;
    case 'remove-task': {
      const task = state.tasks.get(element.dataset.id);
      closeTask(task);
      renderTaskDock();
      break;
    }
    default:
      break;
  }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (['install', 'detail', 'external', 'close-modal', 'confirm-ok', 'confirm-cancel'].includes(action)) {
    event.preventDefault();
  }
  handleAction(action, target).catch((error) => toast(error.message, 'error'));
});

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (form.matches('[data-search-form]')) {
    event.preventDefault();
    const input = $('#search-input');
    state.search.query = String(new FormData(form).get('q') || '').trim();
    state.search.page = 1;
    state.search.items = [];
    state.search.hasMore = false;
    state.search.loaded = false;
    writeSearchHash();
    if (input) input.blur();
    await loadSearch(false);
  }
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.matches('[data-installed-search]')) {
    state.installedQuery = target.value;
    applyInstalledFilter();
  }
});

document.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.name === 'includeConfig') {
    const allRow = $('[data-all-config-row]');
    const allInput = allRow?.querySelector('input');
    if (allRow && allInput) {
      allRow.style.opacity = target.checked ? '1' : '0.45';
      allInput.disabled = !target.checked;
    }
  }
  if (target.id === 'client-select') {
    const option = target.selectedOptions[0];
    if (option) {
      target.disabled = true;
      await switchClient(option.value, option.dataset.flavor);
      target.disabled = false;
    }
    return;
  }
  if (target.id === 'search-version') {
    state.search.versionKey = target.value;
    state.search.page = 1;
    state.search.items = [];
    state.search.hasMore = false;
    await loadSearch(false);
    return;
  }
  if (target.id === 'search-category') {
    state.search.category = target.value;
    state.search.page = 1;
    state.search.items = [];
    state.search.hasMore = false;
    await loadSearch(false);
    return;
  }
  if (target.id === 'search-sort') {
    state.search.sort = target.value;
    state.search.page = 1;
    state.search.items = [];
    state.search.hasMore = false;
    await loadSearch(false);
    return;
  }
  if (target.id === 'ui-scale') {
    const value = Math.max(0.8, Math.min(2, Number(target.value) || 1));
    applyUiScale(value);
    try {
      await patchSettings({ uiScale: value });
      toast(`界面缩放已设为 ${Math.round(value * 100)}%`);
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  if (target.id === 'backup-limit') {
    const value = Math.max(1, Math.min(30, Number(target.value) || 8));
    target.value = String(value);
    try {
      await patchSettings({ backupLimit: value });
      toast(`保留最近 ${value} 份版本备份`);
    } catch (error) {
      toast(error.message, 'error');
    }
  }
});

document.addEventListener('keydown', (event) => {
  const actionable = event.target.closest?.('[data-action]');
  if (
    actionable &&
    !['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(actionable.tagName) &&
    (event.key === 'Enter' || event.key === ' ')
  ) {
    event.preventDefault();
    actionable.click();
    return;
  }
  if (event.key === 'Escape') {
    if ($('#modal-root')?.innerHTML) {
      if (state.confirmResolver) resolveConfirm(false);
      else closeModal();
      return;
    }
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (state.route !== 'search') navigate('#/search');
    setTimeout(() => $('#search-input')?.focus(), 80);
  }
});

window.addEventListener('hashchange', () => {
  if ($('#modal-root')?.innerHTML) closeModal();
  renderRoute().catch((error) => renderFatal(error.message));
});

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  hydrateIcons(document);
  try {
    await loadBootstrap(false);
    await renderRoute();
    try {
      window.webkit?.messageHandlers?.uiReady?.postMessage(`ready:${state.route}`);
    } catch {
      // Browser preview: no native bridge.
    }
  } catch (error) {
    renderFatal(error.message);
  }
}

boot();
