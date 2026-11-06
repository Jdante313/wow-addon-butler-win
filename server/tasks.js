'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const providers = require('./providers');
const wow = require('./wow');
const updates = require('./updates');
const profiles = require('./profiles');
const wtf = require('./lib/wtf');
const store = require('./lib/store');
const { AppError } = require('./lib/errors');
const { DATA_DIR } = require('./config');
const { downloadFile, inferFileName } = require('./lib/http');
const { formatBytes, safeFileName } = require('./lib/utils');
const runtimeState = require('./lib/runtime-state');

const tasks = new Map();
const TTL = 30 * 60 * 1000;

function prune() {
  const cutoff = Date.now() - TTL;
  for (const [id, task] of tasks) {
    if (task.createdAtMs < cutoff && task.status !== 'running') tasks.delete(id);
  }
}

function create(type, title) {
  prune();
  const id = crypto.randomUUID();
  const task = {
    id,
    type,
    title,
    status: 'running',
    stage: '准备中',
    progress: 0,
    detail: '',
    logs: [],
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    finishedAt: null,
  };
  tasks.set(id, task);
  return task;
}

function publicTask(task) {
  return {
    id: task.id,
    type: task.type,
    title: task.title,
    status: task.status,
    stage: task.stage,
    progress: Math.max(0, Math.min(100, Math.round(task.progress))),
    detail: task.detail,
    logs: task.logs.slice(-12),
    result: task.result,
    error: task.error,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
  };
}

function get(id) {
  const task = tasks.get(id);
  if (!task) throw new AppError('任务不存在或已过期', 'TASK_NOT_FOUND', 404);
  return publicTask(task);
}

function update(task, patch) {
  Object.assign(task, patch);
  return task;
}

function log(task, message) {
  task.logs.push({ at: new Date().toISOString(), message });
  task.detail = message;
  return task;
}

async function resolveRemote(source, id, settings) {
  const provider = providers.getProvider(source);
  const [detail, latest] = await Promise.all([
    provider.detail(id, providers.providerContext(settings)).catch(() => null),
    provider.latest(id, providers.providerContext(settings)).catch(() => null),
  ]);
  return { provider, detail, latest };
}

function updateCheckAfterInstall(folders, remote = {}) {
  const lastCheck = runtimeState.getLastCheck();
  if (!lastCheck?.results?.length) return;
  const changed = new Set((folders || []).map((folder) => String(folder).toLowerCase()));
  if (!changed.size) return;
  lastCheck.results = lastCheck.results.map((entry) =>
    changed.has(String(entry.folder || '').toLowerCase())
      ? {
          ...entry,
          status: 'current',
          installedVersion: remote.version || entry.installedVersion,
        }
      : entry,
  );
  const count = (status) => lastCheck.results.filter((entry) => entry.status === status).length;
  lastCheck.counts = {
    ...(lastCheck.counts || {}),
    total: lastCheck.results.length,
    update: count('update'),
    current: count('current'),
    unknown: count('unknown'),
    pinned: count('pinned'),
    error: count('error'),
  };
  runtimeState.setLastCheck(lastCheck);
}

async function installOne(task, { source, id, settings, target, nameHint, batch = false }) {
  const ctx = providers.providerContext(settings);
  update(task, { stage: '解析插件信息', progress: 3 });
  const provider = providers.getProvider(source);
  let detail = null;
  let latest = null;
  try {
    detail = await provider.detail(id, ctx);
  } catch {
    detail = null;
  }
  try {
    latest = await provider.latest(id, ctx);
  } catch {
    latest = null;
  }
  const displayName = detail?.name || latest?.name || nameHint || id;
  log(task, `正在获取 ${displayName} 的下载地址`);

  update(task, { stage: '获取下载地址', progress: 8 });
  const downloadInfo = await provider.download(id, ctx);
  const remoteVersion = latest?.version || detail?.version || '';
  update(task, {
    stage: '下载插件包',
    progress: 12,
    detail: `${downloadInfo.name || '插件包'}${downloadInfo.size ? ` · ${formatBytes(downloadInfo.size)}` : ''}`,
  });

  const tmpDir = path.join(DATA_DIR, 'tmp');
  await fsp.mkdir(tmpDir, { recursive: true });
  const fileName = safeFileName(
    downloadInfo.name || inferFileName(downloadInfo.url, `${source}-${id}.zip`),
    `${source}-${id}.zip`,
  );
  const zipPath = path.join(tmpDir, `${crypto.randomUUID()}-${fileName}`);
  let lastPercent = -1;
  try {
    await downloadFile(downloadInfo.url, zipPath, {
      onProgress: ({ received, total, percent }) => {
        const mapped = 12 + Math.round((percent || 0) * 0.58);
        if (mapped !== lastPercent) {
          lastPercent = mapped;
          update(task, {
            progress: mapped,
            stage: '下载插件包',
            detail: total
              ? `${formatBytes(received)} / ${formatBytes(total)}`
              : `已下载 ${formatBytes(received)}`,
          });
        }
      },
    });
    update(task, { stage: '校验并解压', progress: 72, detail: '正在检查 TOC 与文件结构' });
    const result = await wow.installZip(
      zipPath,
      target.addonPath,
      {
        source,
        remoteId: id,
        remoteName: displayName,
        remoteVersion,
        icon: detail?.icon || '',
        url: detail?.url || '',
        zipName: fileName,
      },
      { flavorFolder: target.folder },
    );
    updateCheckAfterInstall(result.folders, { version: remoteVersion });
    update(task, {
      ...(batch ? {} : { status: 'success' }),
      stage: '安装完成',
      progress: batch ? Math.min(96, Number(task.progress) || 72) : 100,
      result: {
        ...result,
        name: displayName,
        remoteVersion,
        source,
        sourceLabel: provider.label,
      },
      ...(batch ? {} : { finishedAt: new Date().toISOString() }),
    });
    log(task, `${displayName} 已安装到 ${target.addonPath}`);
    return result;
  } finally {
    await fsp.rm(zipPath, { force: true }).catch(() => {});
  }
}

function startInstall({ source, id, nameHint }) {
  const settings = store.loadSettings();
  const task = create('install', nameHint ? `安装 ${nameHint}` : '安装插件');
  (async () => {
    try {
      const target = await wow.resolveAddonPath(settings);
      if (!target.addonPath) throw new AppError('请先在设置中选择魔兽世界插件目录', 'NO_ADDON_PATH', 400);
      await installOne(task, { source, id, settings, target, nameHint });
    } catch (error) {
      update(task, {
        status: 'error',
        stage: '安装失败',
        error: error.message || '安装失败',
        finishedAt: new Date().toISOString(),
      });
      log(task, error.message || '安装失败');
    }
  })();
  return publicTask(task);
}

function startInstallLocal({ filePath, nameHint }) {
  const settings = store.loadSettings();
  const fileName = path.basename(String(filePath || '')) || nameHint || '本地插件包';
  const task = create('install-local', `安装本地包 ${fileName}`);
  (async () => {
    try {
      const target = await wow.resolveAddonPath(settings);
      if (!target.addonPath) {
        throw new AppError('请先在设置中选择魔兽世界插件目录', 'NO_ADDON_PATH', 400);
      }
      update(task, { stage: '读取压缩包', progress: 8, detail: fileName });
      const stat = await fsp.stat(filePath);
      update(task, {
        stage: '校验并解压',
        progress: 35,
        detail: `${fileName}${stat?.size ? ` · ${formatBytes(stat.size)}` : ''}`,
      });
      const result = await wow.installZip(
        filePath,
        target.addonPath,
        {
          source: 'local',
          remoteId: `local:${fileName}`,
          remoteName: '',
          zipName: fileName,
        },
        { flavorFolder: target.folder },
      );
      updateCheckAfterInstall(result.folders);
      const names = (result.installed || []).map((addon) => addon.name).filter(Boolean);
      update(task, {
        status: 'success',
        stage: '安装完成',
        progress: 100,
        detail: names.join('、') || result.folders.join('、'),
        result: {
          ...result,
          name: names[0] || fileName,
          source: 'local',
          sourceLabel: '本地压缩包',
        },
        finishedAt: new Date().toISOString(),
      });
      log(task, `${fileName} 已安装到 ${target.addonPath}`);
    } catch (error) {
      update(task, {
        status: 'error',
        stage: '安装失败',
        error: error.message || '安装失败',
        finishedAt: new Date().toISOString(),
      });
      log(task, error.message || '安装失败');
    }
  })();
  return publicTask(task);
}

function startUpdate({ folder }) {
  const settings = store.loadSettings();
  const task = create('update', `更新 ${folder || '插件'}`);
  (async () => {
    try {
      const target = await wow.resolveAddonPath(settings);
      if (!target.addonPath) throw new AppError('请先在设置中选择魔兽世界插件目录', 'NO_ADDON_PATH', 400);
      const scan = await wow.scanAddons(target.addonPath, target.folder, { force: true });
      const addon = scan.addons.find(
        (item) => item.baseFolder.toLowerCase() === String(folder).toLowerCase(),
      );
      if (!addon) throw new AppError('没有找到这个插件', 'NOT_FOUND', 404);
      const checked = await updates.checkAddon(addon, settings);
      if (checked.status !== 'update') {
        throw new AppError(
          checked.status === 'current'
            ? '当前已经是最新版本'
            : checked.status === 'pinned'
              ? '这个插件已固定版本，不会自动更新'
              : '未能确认这个插件的最新版本',
          'NO_UPDATE',
          409,
        );
      }
      await installOne(task, {
        source: checked.remote.source,
        id: checked.remote.id,
        settings,
        target,
        nameHint: addon.name,
      });
    } catch (error) {
      update(task, {
        status: 'error',
        stage: '更新失败',
        error: error.message || '更新失败',
        finishedAt: new Date().toISOString(),
      });
      log(task, error.message || '更新失败');
    }
  })();
  return publicTask(task);
}

function startUpdateAll() {
  const settings = store.loadSettings();
  const task = create('update-all', '更新全部插件');
  (async () => {
    try {
      const target = await wow.resolveAddonPath(settings);
      if (!target.addonPath) throw new AppError('请先在设置中选择魔兽世界插件目录', 'NO_ADDON_PATH', 400);
      update(task, { stage: '检查更新', progress: 2 });
      const checked = await updates.checkAll({
        onProgress: ({ done, total, addon }) => {
          update(task, {
            stage: '检查更新',
            progress: 2 + Math.round((done / Math.max(1, total)) * 10),
            detail: `正在检查 ${addon}（${done}/${total}）`,
          });
        },
      });
      const pending = checked.results.filter((item) => item.status === 'update');
      runtimeState.setLastCheck(checked);
      if (!pending.length) {
        update(task, {
          status: 'success',
          stage: '已是最新',
          progress: 100,
          result: { updated: [], failed: [], skipped: checked.results.length },
          finishedAt: new Date().toISOString(),
        });
        return;
      }
      const updated = [];
      const failed = [];
      for (let index = 0; index < pending.length; index += 1) {
        const entry = pending[index];
        const baseProgress = 12 + (index / pending.length) * 86;
        update(task, {
          stage: `更新 ${index + 1}/${pending.length}`,
          progress: baseProgress,
          detail: entry.addon.name,
        });
        try {
          const before = task.progress;
          await installOne(task, {
            source: entry.remote.source,
            id: entry.remote.id,
            settings,
            target,
            nameHint: entry.addon.name,
            batch: true,
          });
          updated.push({ name: entry.addon.name, from: entry.installedVersion, to: entry.remote.version });
          update(task, { progress: Math.max(before, baseProgress + 86 / pending.length) });
        } catch (error) {
          failed.push({ name: entry.addon.name, error: error.message });
          log(task, `${entry.addon.name} 更新失败：${error.message}`);
          update(task, { progress: baseProgress + 86 / pending.length });
        }
      }
      update(task, {
        status: failed.length ? 'partial' : 'success',
        stage: failed.length ? '部分插件更新失败' : '全部更新完成',
        progress: 100,
        result: { updated, failed, skipped: checked.results.length - pending.length },
        error: failed.length ? `${failed.length} 个插件更新失败` : null,
        finishedAt: new Date().toISOString(),
      });
      const updatedNames = new Set(updated.map((entry) => entry.name));
      const refreshed = {
        ...checked,
        results: checked.results.map((entry) =>
          updatedNames.has(entry.addon.name) && entry.status === 'update'
            ? { ...entry, status: 'current', installedVersion: entry.remote?.version || entry.installedVersion }
            : entry,
        ),
      };
      refreshed.counts = {
        ...refreshed.counts,
        update: refreshed.results.filter((entry) => entry.status === 'update').length,
        current: refreshed.results.filter((entry) => entry.status === 'current').length,
      };
      runtimeState.setLastCheck(refreshed);
    } catch (error) {
      update(task, {
        status: 'error',
        stage: '更新失败',
        error: error.message || '更新失败',
        finishedAt: new Date().toISOString(),
      });
      log(task, error.message || '更新失败');
    }
  })();
  return publicTask(task);
}

function startCheck() {
  const task = create('check', '检查插件更新');
  (async () => {
    try {
      update(task, { stage: '扫描本地插件', progress: 2 });
      const result = await updates.checkAll({
        onProgress: ({ done, total, addon }) => {
          update(task, {
            stage: '匹配在线版本',
            progress: 5 + Math.round((done / Math.max(1, total)) * 92),
            detail: `正在检查 ${addon}（${done}/${total}）`,
          });
        },
      });
      runtimeState.setLastCheck(result);
      update(task, {
        status: 'success',
        stage: '检查完成',
        progress: 100,
        result,
        detail: `发现 ${result.counts.update} 个可更新插件`,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      update(task, {
        status: 'error',
        stage: '检查失败',
        error: error.message || '检查失败',
        finishedAt: new Date().toISOString(),
      });
    }
  })();
  return publicTask(task);
}


function startProfileRestore({ profileId, options = {} }) {
  const settings = store.loadSettings();
  const task = create('profile-restore', '恢复配置快照');
  (async () => {
    let tempDir = '';
    try {
      const target = await wow.resolveAddonPath(settings);
      if (!target.addonPath) throw new AppError('请先在设置中选择魔兽世界插件目录', 'NO_ADDON_PATH', 400);
      const profile = profiles.getProfile(profileId);
      const manifest = profile.manifest;
      const wanted = new Set(Array.isArray(options.addons) ? options.addons.map(String) : []);
      const entries = (manifest.addons || []).filter((entry) =>
        wanted.size ? wanted.has(String(entry.key)) || wanted.has(String(entry.name)) : true,
      );
      const { zip } = profiles.readManifestFile(profiles.profilePathFor(profileId));
      tempDir = await profiles.ensureTempDir();
      update(task, { stage: '扫描本地插件', progress: 2 });
      const scan = await wow.scanAddons(target.addonPath, target.folder, { force: true });
      const existing = new Set(scan.addons.map((addon) => addon.baseFolder.toLowerCase()));
      const installed = [];
      const skipped = [];
      const failed = [];
      const totalSteps = entries.length + (options.restoreConfig ? 1 : 0) || 1;
      let step = 0;
      for (const entry of entries) {
        step += 1;
        const present = (entry.folders || []).every((folder) =>
          existing.has(String(folder).toLowerCase()),
        );
        if (present && !options.overwrite) {
          skipped.push({ name: entry.name, reason: '已安装' });
          continue;
        }
        const baseProgress = 4 + ((step - 1) / totalSteps) * 88;
        update(task, {
          stage: `恢复 ${entry.name}`,
          progress: baseProgress,
          detail: `${entry.name} · ${(entry.folders || []).length} 个文件夹`,
        });
        try {
          if (entry.fileName && zip.getEntry(`addons/${entry.fileName}`)) {
            const zipPath = profiles.embeddedAddonPath(zip, entry, tempDir);
            await wow.installZip(
              zipPath,
              target.addonPath,
              {
                source: entry.source || 'profile',
                remoteId: entry.remoteId || entry.key || entry.name,
                remoteName: entry.name,
                remoteVersion: entry.version || '',
                zipName: entry.fileName,
              },
              { flavorFolder: target.folder },
            );
            if (Array.isArray(entry.folderStates)) {
              for (const state of entry.folderStates) {
                if (state.enabled === false) {
                  await wow.setEnabled(target.addonPath, state.folder, false).catch(() => {});
                }
              }
            }
            installed.push({ name: entry.name, version: entry.version || '', from: '快照文件' });
          } else if (entry.source && entry.remoteId && providers.providers[entry.source]) {
            await installOne(task, {
              source: entry.source,
              id: String(entry.remoteId),
              settings,
              target,
              nameHint: entry.name,
              batch: true,
            });
            installed.push({ name: entry.name, version: entry.version || '', from: '在线来源' });
          } else {
            failed.push({ name: entry.name, error: '快照没有包含插件文件，也没有可用的在线来源' });
          }
        } catch (error) {
          failed.push({ name: entry.name, error: error.message || '恢复失败' });
          log(task, `${entry.name} 恢复失败：${error.message}`);
        }
        update(task, { progress: Math.min(94, baseProgress + 88 / totalSteps) });
      }

      let config = null;
      if (options.restoreConfig && (manifest.config?.files || []).length) {
        update(task, { stage: '恢复角色配置', progress: 94, detail: '正在写回 SavedVariables' });
        if (await wow.isWowRunning()) {
          config = {
            restored: [],
            errors: ['检测到魔兽世界正在运行，配置未写入。请退出游戏后重新恢复配置。'],
            bytes: 0,
          };
        } else {
          config = wtf.restoreConfigFromZip(zip, target.addonPath);
        }
      }

      const partial = failed.length > 0 || (config && config.errors.length);
      update(task, {
        status: partial ? 'partial' : 'success',
        stage: partial ? '恢复完成（有跳过或失败）' : '恢复完成',
        progress: 100,
        result: {
          installed,
          skipped,
          failed,
          config,
          profileName: manifest.name,
          addonPath: target.addonPath,
        },
        error: failed.length ? `${failed.length} 个插件未能恢复` : null,
        finishedAt: new Date().toISOString(),
      });
      log(task, `快照「${manifest.name}」已恢复`);
    } catch (error) {
      update(task, {
        status: 'error',
        stage: '恢复失败',
        error: error.message || '恢复失败',
        finishedAt: new Date().toISOString(),
      });
      log(task, error.message || '恢复失败');
    } finally {
      if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return publicTask(task);
}

module.exports = {
  create,
  get,
  startInstall,
  startInstallLocal,
  startUpdate,
  startUpdateAll,
  startCheck,
  startProfileRestore,
  publicTask,
};
