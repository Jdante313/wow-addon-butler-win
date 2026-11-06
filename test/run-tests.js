'use strict';

/**
 * Backend tests for the macOS build.
 * Runs against a throwaway data directory and a fake WoW install so it never
 * touches the real game folder.
 *
 *   node test/run-tests.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-test-'));
const DATA = path.join(ROOT, 'data');
const GAME = path.join(ROOT, 'game');
process.env.WOW_BUTLER_DATA = DATA;
process.env.WOW_BUTLER_GAME_ROOT = GAME;
process.env.WOW_BUTLER_ONLY_GAME_ROOT = '1';
process.env.WOW_BUTLER_NO_OPEN = '1';

const wow = require('../server/wow');
const store = require('../server/lib/store');
const match = require('../server/lib/match');
const utils = require('../server/lib/utils');
const group = require('../server/lib/group');
const profiles = require('../server/profiles');
const tasks = require('../server/tasks');
const wtf = require('../server/lib/wtf');
const { matchesCategory, SEARCH_CATEGORIES } = require('../server/categories');
const { WTF_BACKUP_DIR } = require('../server/config');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
  }
}

function writeToc(dir, folder, toc) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${folder}.toc`), toc, 'utf8');
  fs.writeFileSync(path.join(dir, `${folder}.lua`), '-- fixture\n', 'utf8');
}

function makeClient(root, flavor) {
  const client = path.join(root, flavor);
  const addons = path.join(client, 'Interface', 'AddOns');
  fs.mkdirSync(addons, { recursive: true });
  fs.writeFileSync(path.join(client, '.flavor.info'), `Product Flavor!STRING:0\n${flavor === '_retail_' ? 'wow' : 'wowf'}`, 'utf8');
  return { client, addons };
}

function makeAddons(addonsDir) {
  writeToc(
    path.join(addonsDir, 'Details'),
    'Details',
    [
      '## Interface: 16000',
      '## Title: Details! Damage Meter',
      '## Title-zhCN: Details! 伤害统计',
      '## Notes-zhCN: 战斗统计插件',
      '## Version: #Details.20261015.15339',
      '## Author: NewBeeBox',
      '## X-Localization: zhCN',
      '## SavedVariables: DetailsDB',
      '## SavedVariablesPerCharacter: DetailsCharDB',
      '## Dependencies: Ace3',
      '',
    ].join('\n'),
  );
  for (const folder of ['DungeonsForever', 'DungeonsForeverClass', 'DungeonsForeverSpell']) {
    writeToc(
      path.join(addonsDir, folder),
      folder,
      [
        '## Interface: 16000',
        `## Title: ${folder}`,
        '## Version: 2.0.9',
        '## Author: 圆圈',
        '## Group: DungeonsForever',
        '## X-Localization: zhCN',
        '',
      ].join('\n'),
    );
  }
  writeToc(
    path.join(addonsDir, 'Questie'),
    'Questie',
    ['## Interface: 16000', '## Title: Questie', '## Version: 11.5.0', ''].join('\n'),
  );
  writeToc(
    path.join(addonsDir, 'BigWigs'),
    'BigWigs',
    ['## Interface: 16000', '## Title: BigWigs', '## Version: 1.0.0', ''].join('\n'),
  );
  fs.renameSync(path.join(addonsDir, 'BigWigs'), path.join(addonsDir, 'BigWigs.disabled'));
  writeToc(
    path.join(addonsDir, 'Ace3'),
    'Ace3',
    ['## Interface: 16000', '## Title: Ace3', '## Version: 3.1.0', ''].join('\n'),
  );
}

async function setupFixtures() {
  const { addons, client } = makeClient(GAME, '_forever_');
  makeAddons(addons);
  const wtfDir = path.join(client, 'WTF', 'Account', '123', 'SavedVariables');
  fs.mkdirSync(wtfDir, { recursive: true });
  fs.writeFileSync(path.join(wtfDir, 'Details.lua'), 'DetailsDB = {}\n');
  fs.writeFileSync(path.join(wtfDir, 'Questie.lua'), 'QuestieDB = {}\n');
  const charDir = path.join(client, 'WTF', 'Account', '123', 'Realm', 'Hero', 'SavedVariables');
  fs.mkdirSync(charDir, { recursive: true });
  fs.writeFileSync(path.join(charDir, 'Details.lua'), 'DetailsCharDB = {}\n');

  const retail = makeClient(GAME, '_retail_');
  writeToc(
    path.join(retail.addons, 'ElvUI'),
    'ElvUI',
    ['## Interface: 110200', '## Title: ElvUI', '## Version: 13.90', ''].join('\n'),
  );

  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(
    path.join(DATA, 'settings.json'),
    JSON.stringify(
      {
        wowRoot: GAME,
        flavor: 'unlimited',
        addonPath: path.join(client, 'Interface', 'AddOns'),
        wclboxVersion: 9,
        sources: { wclbox: true, curseforge: false, tukui: true },
      },
      null,
      2,
    ),
  );
}

async function waitTask(id, timeout = 20000) {
  const started = Date.now();
  for (;;) {
    const task = tasks.get(id);
    if (task.status !== 'running') return task;
    if (Date.now() - started > timeout) throw new Error('task timeout');
    await utils.sleep(150);
  }
}

async function main() {
  console.log(`temp: ${ROOT}`);
  await setupFixtures();
  const target = await wow.resolveAddonPath(store.loadSettings());
  assert.equal(target.flavor, 'unlimited');
  assert.equal(target.folder, '_forever_');

  await test('detectInstallations finds both clients and build versions', async () => {
    const list = await wow.detectInstallations();
    assert.equal(list.length, 1);
    const folders = list[0].flavors.map((flavor) => flavor.folder).sort();
    assert.deepEqual(folders, ['_forever_', '_retail_']);
  });

  await test('parseToc reads Chinese title, clean version, deps and saved variables', () => {
    const toc = wow.parseToc(
      [
        '## Interface: 16000, 16005',
        '## Title: Base',
        '## Title-zhCN: 中文标题',
        '## Version: #1.2.3',
        '## Author: Tester',
        '## Dependencies: Ace3, LibStub',
        '## OptionalDeps: Details',
        '## SavedVariables: DB1, DB2',
        '',
      ].join('\n'),
      'Demo.toc',
    );
    assert.equal(toc.title, '中文标题');
    assert.equal(toc.version, '1.2.3');
    assert.deepEqual(toc.interfaces, [16000, 16005]);
    assert.deepEqual(toc.dependencies, ['Ace3', 'LibStub']);
    assert.deepEqual(toc.optionalDeps, ['Details']);
    assert.deepEqual(toc.savedVariables, ['DB1', 'DB2']);
  });

  await test('version comparison handles dates and v prefixes', () => {
    assert.equal(utils.compareVersions('1.2.0', '1.10.0'), -1);
    assert.equal(utils.compareVersions('v1.3.7', '1.3.7'), 0);
    assert.equal(utils.isVersionNewer('26.10.26', '1.4.0'), true);
    assert.equal(utils.compareVersions('abc', ''), null);
  });

  await test('match splits exact names and fuzzy results', () => {
    const items = [
      { name: 'Details! Damage Meter', summary: 'damage meter', downloads: 10, author: '' },
      { name: 'Damage Meter Forever', summary: 'details alternative', downloads: 5, author: '' },
      { name: 'Questie', summary: 'quest helper', downloads: 8, author: '' },
      { name: 'NewBeeBox', summary: 'details pack', downloads: 2, author: 'Details' },
    ];
    const { exact, fuzzy } = match.splitSearchResults(items, 'Details');
    assert.deepEqual(
      exact.map((item) => item.name),
      ['Details! Damage Meter', 'NewBeeBox'],
    );
    assert.ok(fuzzy.some((item) => item.name === 'Damage Meter Forever'));
    assert.ok(!exact.some((item) => item.name === 'Questie'));
  });

  await test('category taxonomy labels and keyword matching', () => {
    assert.ok(SEARCH_CATEGORIES.length >= 9);
    assert.equal(matchesCategory({ name: 'Questie', summary: '任务助手' }, 'quest'), true);
    assert.equal(matchesCategory({ name: 'ElvUI', summary: 'user interface' }, 'ui'), true);
    assert.equal(matchesCategory({ name: 'Details!', summary: '伤害统计' }, 'combat'), true);
    assert.equal(
      matchesCategory(
        {
          name: 'ElvUI',
          summary: 'A user interface replacement',
          description: 'mentions threat in a long description',
        },
        'combat',
      ),
      false,
    );
  });

  await test('scanAddons merges groups, detects disabled and language', async () => {
    const scan = await wow.scanAddons(target.addonPath, target.folder, { force: true });
    assert.equal(scan.exists, true);
    const grouped = group.groupInstalledAddons(scan.addons);
    const byName = new Map(grouped.map((entry) => [entry.name, entry]));
    assert.equal(byName.get('DungeonsForever').folderCount, 3);
    assert.equal(byName.get('Details! 伤害统计').language, 'zh');
    assert.equal(byName.get('BigWigs').enabled, false);
    assert.equal(byName.get('Ace3').isLibrary, true);
  });

  await test('installZip installs wrapped multi-folder zip and backs up old files', async () => {
    const zip = new AdmZip();
    const prefix = 'MyPack-1.2.0/';
    zip.addFile(`${prefix}MyAddon/MyAddon.toc`, Buffer.from('## Interface: 16000\n## Title: MyAddon\n## Version: 2.0.0\n'));
    zip.addFile(`${prefix}MyAddon/MyAddon.lua`, Buffer.from('-- my addon\n'));
    zip.addFile(`${prefix}MyAddon_Extra/MyAddon_Extra.toc`, Buffer.from('## Interface: 16000\n## Title: MyAddon Extra\n## Version: 2.0.0\n'));
    zip.addFile(`${prefix}MyAddon_Extra/MyAddon_Extra.lua`, Buffer.from('-- extra\n'));
    const zipPath = path.join(ROOT, 'mypack.zip');
    zip.writeZip(zipPath);

    const before = fs.readdirSync(target.addonPath);
    const result = await wow.installZip(
      zipPath,
      target.addonPath,
      { source: 'wclbox', remoteId: '99', remoteName: 'MyAddon', remoteVersion: '2.0.0' },
      { flavorFolder: target.folder },
    );
    assert.deepEqual(result.folders.sort(), ['MyAddon', 'MyAddon_Extra']);
    assert.ok(fs.existsSync(path.join(target.addonPath, 'MyAddon', 'MyAddon.toc')));
    assert.equal(fs.readdirSync(target.addonPath).length, before.length + 2);

    const result2 = await wow.installZip(
      zipPath,
      target.addonPath,
      { source: 'wclbox', remoteId: '99', remoteName: 'MyAddon', remoteVersion: '2.0.1' },
      { flavorFolder: target.folder },
    );
    assert.equal(result2.backups.length, 2);
    assert.ok(await wow.listBackups().then((list) => list.length >= 2));
  });

  await test('local zip install records a local package and appears in scan', async () => {
    const localZip = new AdmZip();
    localZip.addFile('LocalPack/LocalPack.toc', Buffer.from('## Interface: 16000\n## Title: LocalPack\n## Version: 1.2.0\n'));
    localZip.addFile('LocalPack/LocalPack.lua', Buffer.from('-- local pack\n'));
    const localPath = path.join(ROOT, 'local-pack.zip');
    localZip.writeZip(localPath);
    const task = tasks.startInstallLocal({ filePath: localPath, nameHint: 'local-pack.zip' });
    const done = await waitTask(task.id);
    assert.equal(done.status, 'success', done.error || '');
    assert.ok(fs.existsSync(path.join(target.addonPath, 'LocalPack', 'LocalPack.toc')));
    const managed = store.loadManaged();
    const record = Object.values(managed.packages).find((pkg) => pkg.source === 'local');
    assert.ok(record, 'local package should be recorded');
    assert.ok(record.folders.includes('LocalPack'));
  });

  await test('setEnabled renames folder to .disabled and back', async () => {
    await wow.setEnabled(target.addonPath, 'Questie', false);
    assert.ok(fs.existsSync(path.join(target.addonPath, 'Questie.disabled')));
    await wow.setEnabled(target.addonPath, 'Questie', true);
    assert.ok(fs.existsSync(path.join(target.addonPath, 'Questie')));
  });

  await test('profile snapshot records manifests, embedded addons and SavedVariables', async () => {
    const profile = await profiles.createProfile({
      name: 'QA profile',
      note: 'unit test',
      includeFiles: true,
      includeConfig: true,
      includeAllConfig: true,
    });
    assert.ok(profile.id);
    assert.ok(profile.stats.addons >= 5);
    assert.ok(profile.stats.configFiles >= 3);
    const detail = profiles.getProfile(profile.id);
    assert.equal(detail.manifest.addons.length, profile.stats.addons);
    assert.ok(detail.manifest.addons.some((entry) => entry.folders.includes('DungeonsForever')));
    assert.ok(detail.manifest.addons.some((entry) => entry.folderStates?.some((state) => state.enabled === false)));
    assert.equal(detail.manifest.config.files.length, 3);
    const listed = await profiles.listProfiles();
    assert.ok(listed.some((entry) => entry.id === profile.id));
    global.__profileId = profile.id;
  });

  await test('profile preview reports missing addons and config files', async () => {
    const emptyRoot = path.join(ROOT, 'empty-game');
    const empty = makeClient(emptyRoot, '_forever_');
    const preview = await profiles.previewRestore(global.__profileId, {
      addonPath: empty.addons,
      folder: '_forever_',
    });
    assert.equal(preview.summary.installed, 0);
    assert.ok(preview.summary.missing >= 5);
    assert.ok(preview.summary.configFiles >= 3);
    global.__emptyGame = emptyRoot;
  });

  await test('profile restore installs files, restores config and keeps disabled state', async () => {
    const empty = makeClient(global.__emptyGame, '_forever_');
    store.saveSettings({
      addonPath: empty.addons,
      wowRoot: global.__emptyGame,
      flavor: 'unlimited',
      wclboxVersion: 9,
    });
    const existingWtf = path.join(empty.client, 'WTF', 'Account', '123', 'SavedVariables');
    fs.mkdirSync(existingWtf, { recursive: true });
    fs.writeFileSync(path.join(existingWtf, 'Details.lua'), 'DetailsDB = { old = true }\n');
    const task = tasks.startProfileRestore({
      profileId: global.__profileId,
      options: { restoreConfig: true, overwrite: false },
    });
    const done = await waitTask(task.id);
    assert.equal(done.status, 'success', done.error || '');
    assert.ok(fs.existsSync(path.join(empty.addons, 'MyAddon', 'MyAddon.toc')));
    assert.ok(fs.existsSync(path.join(empty.addons, 'BigWigs.disabled')));
    const restored = fs.readFileSync(
      path.join(empty.client, 'WTF', 'Account', '123', 'SavedVariables', 'Details.lua'),
      'utf8',
    );
    assert.match(restored, /DetailsDB/);
    const backups = fs.readdirSync(WTF_BACKUP_DIR);
    assert.ok(backups.length >= 1, 'existing WTF file should be backed up');
    global.__emptyAddons = empty.addons;
    global.__emptyClient = empty.client;
  });

  await test('config collection filters addon SavedVariables when requested', async () => {
    const all = await wtf.listSavedVariables(target.addonPath, [], { includeAll: true });
    assert.ok(all.files.length >= 3);
    const filtered = await wtf.listSavedVariables(
      target.addonPath,
      [{ baseFolder: 'Details', savedVariables: ['DetailsDB'] }],
      { includeAll: false },
    );
    assert.ok(filtered.files.some((file) => file.name === 'Details.lua'));
    assert.ok(!filtered.files.some((file) => file.name === 'Questie.lua'));
  });

  await test('profile export and re-import keeps the manifest', async () => {
    const exported = path.join(ROOT, 'exported.wowpack');
    await profiles.exportProfile(global.__profileId, exported);
    assert.ok(fs.existsSync(exported));
    const imported = await profiles.importProfile(exported);
    assert.equal(imported.stats.addons, profiles.getProfile(global.__profileId).stats.addons);
    assert.ok((await profiles.listProfiles()).length >= 2);
  });

  await test('uninstall removes a disabled-only addon by its base folder name', async () => {
    const folder = path.join(target.addonPath, 'TempDisabled.disabled');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'TempDisabled.toc'), '## Interface: 16000\n## Title: TempDisabled\n');
    await wow.uninstallAddon(target.addonPath, 'TempDisabled', { backup: false });
    assert.ok(!fs.existsSync(path.join(target.addonPath, 'TempDisabled')));
    assert.ok(!fs.existsSync(path.join(target.addonPath, 'TempDisabled.disabled')));
  });

  await test('uninstall removes every folder of a grouped addon', async () => {
    const scan = await wow.scanAddons(target.addonPath, target.folder, { force: true });
    const df = scan.addons.find((addon) => addon.baseFolder === 'DungeonsForever');
    assert.ok(df);
    await wow.uninstallAddon(target.addonPath, 'DungeonsForever', {
      backup: false,
      folders: ['DungeonsForever', 'DungeonsForeverClass', 'DungeonsForeverSpell'],
    });
    for (const folder of ['DungeonsForever', 'DungeonsForeverClass', 'DungeonsForeverSpell']) {
      assert.ok(!fs.existsSync(path.join(target.addonPath, folder)), folder);
    }
  });

  await test('datadir is isolated from the real game install', () => {
    assert.ok(DATA.startsWith(ROOT));
    assert.ok(!fs.existsSync('/Applications/World of Warcraft/_forever_/Interface/AddOns/MyAddon'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`);
    process.exitCode = 1;
  } else {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
