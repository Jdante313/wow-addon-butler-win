'use strict';

const { normalizeName } = require('./utils');

/**
 * Group the raw AddOns folders into user-facing packages.
 * A package such as DungeonsForever is shipped as 8 sibling folders but is
 * one plugin in the UI.
 */
function groupInstalledAddons(addons, updateByFolder = new Map()) {
  const groups = new Map();
  const declaredGroups = new Set(
    addons
      .map((addon) => normalizeName(addon.group || ''))
      .filter(Boolean),
  );
  for (const addon of addons) {
    const matchingGroup = declaredGroups.has(normalizeName(addon.baseFolder))
      ? addon.baseFolder
      : addon.group || '';
    const key = addon.managed?.packageId
      || (matchingGroup ? `group:${normalizeName(matchingGroup)}` : `local:${addon.baseFolder.toLowerCase()}`);
    const update =
      updateByFolder.get(String(addon.baseFolder).toLowerCase()) ||
      updateByFolder.get(String(addon.folder).toLowerCase()) ||
      null;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        packageId: addon.managed?.packageId || '',
        name: addon.managed?.remoteName || addon.name,
        folder: addon.baseFolder,
        baseFolder: addon.baseFolder,
        folders: [addon.baseFolder],
        path: addon.path,
        enabled: addon.enabled,
        enabledCount: addon.enabled ? 1 : 0,
        mixed: false,
        version: addon.version,
        author: addon.author,
        notes: addon.notes,
        tocFile: addon.tocFile,
        interface: addon.interface,
        interfaces: addon.interfaces,
        dependencies: addon.dependencies,
        optionalDeps: addon.optionalDeps,
        savedVariables: addon.savedVariables,
        savedVariablesPerCharacter: addon.savedVariablesPerCharacter,
        category: addon.category,
        language: addon.language,
        languageEvidence: addon.languageEvidence,
        modifiedAt: addon.modifiedAt,
        isLibrary: Boolean(addon.isLibrary),
        managed: addon.managed,
        source: addon.source,
        remoteId: addon.remoteId,
        update,
        primary: addon,
      });
      continue;
    }
    const group = groups.get(key);
    if (!group.folders.includes(addon.baseFolder)) group.folders.push(addon.baseFolder);
    if (addon.enabled) group.enabledCount += 1;
    if (addon.modifiedAt > group.modifiedAt) group.modifiedAt = addon.modifiedAt;
    if (addon.language === 'zh' || (!group.language && addon.language)) {
      group.language = addon.language;
      group.languageEvidence = addon.languageEvidence;
    }
    if (!group.isLibrary || addon.isLibrary === false) {
      if (group.isLibrary || !addon.isLibrary) {
        // Prefer a non-library primary folder, then the first folder in the
        // package manifest.
        const current = group.primary;
        if (
          !current ||
          (current.isLibrary && !addon.isLibrary) ||
          normalizeName(addon.baseFolder) === normalizeName(group.name) ||
          normalizeName(addon.baseFolder) === normalizeName(matchingGroup)
        ) {
          group.primary = addon;
          group.folder = addon.baseFolder;
          group.baseFolder = addon.baseFolder;
          group.path = addon.path;
          group.version = addon.version || group.version;
          group.author = addon.author || group.author;
          group.notes = addon.notes || group.notes;
          group.tocFile = addon.tocFile || group.tocFile;
          group.interface = addon.interface || group.interface;
          group.savedVariables = addon.savedVariables || group.savedVariables;
          if (
            !group.managed &&
            matchingGroup &&
            normalizeName(addon.baseFolder) === normalizeName(matchingGroup)
          ) {
            group.name = addon.name;
          }
        }
      }
    }
    if (!group.managed && addon.managed) {
      group.managed = addon.managed;
      group.packageId = addon.managed.packageId;
      group.source = addon.source;
      group.remoteId = addon.remoteId;
      group.name = addon.managed.remoteName || group.name;
    }
    if (
      addon.managed?.remoteName &&
      normalizeName(addon.baseFolder) === normalizeName(addon.managed.remoteName) &&
      group.primary !== addon
    ) {
      group.primary = addon;
      group.folder = addon.baseFolder;
      group.baseFolder = addon.baseFolder;
      group.path = addon.path;
      group.version = addon.version || group.version;
      group.author = addon.author || group.author;
      group.notes = addon.notes || group.notes;
      group.tocFile = addon.tocFile || group.tocFile;
      group.interface = addon.interface || group.interface;
    }
    if (!group.update || addon.update?.status === 'update') {
      group.update = addon.update || group.update;
    }
  }

  const result = Array.from(groups.values()).map((group) => {
    group.folderCount = group.folders.length;
    group.mixed = group.enabledCount > 0 && group.enabledCount < group.folders.length;
    group.enabled = group.enabledCount === group.folders.length;
    group.isLibrary = group.isLibrary && !group.managed;
    return group;
  });
  result.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return result;
}

function groupedStats(groups, rawStats = {}) {
  return {
    total: groups.length,
    enabled: groups.filter((group) => group.enabled).length,
    disabled: groups.filter((group) => !group.enabled && !group.mixed).length,
    mixed: groups.filter((group) => group.mixed).length,
    libraries: groups.filter((group) => group.isLibrary).length,
    folders: Number(rawStats.total || 0),
  };
}

module.exports = { groupInstalledAddons, groupedStats };
