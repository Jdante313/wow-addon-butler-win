'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { AppError } = require('./errors');

const execFileAsync = promisify(execFile);

function isSupported() {
  return process.platform === 'win32';
}

function psQuote(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

async function runDialog(script, env = {}) {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        timeout: 10 * 60 * 1000,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, ...env },
      },
    );
    const lines = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const selected = lines
      .filter((line) => line.startsWith('OK:'))
      .map((line) => line.slice(3))
      .pop();
    return { path: selected || '', canceled: !selected };
  } catch (error) {
    throw new AppError(`无法打开系统选择窗口：${error.message}`, 'DIALOG_FAILED', 500);
  }
}

async function pickFolder({ title = '选择文件夹', defaultPath = '' } = {}) {
  if (!isSupported()) {
    throw new AppError('当前系统不支持原生文件夹选择，请手动填写路径', 'UNSUPPORTED', 400);
  }
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$d.Description = ${psQuote(title)}`,
    'if ($env:WOW_BUTLER_PICK_DEFAULT -and (Test-Path -LiteralPath $env:WOW_BUTLER_PICK_DEFAULT)) { $d.SelectedPath = $env:WOW_BUTLER_PICK_DEFAULT }',    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '  [Console]::Out.WriteLine("OK:" + $d.SelectedPath)',
    '}',
  ].join('; ');
  return runDialog(script, { WOW_BUTLER_PICK_DEFAULT: defaultPath || '' });
}

async function pickFile({ title = '选择文件', defaultPath = '' } = {}) {
  if (!isSupported()) {
    throw new AppError('当前系统不支持原生文件选择，请手动填写路径', 'UNSUPPORTED', 400);
  }
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    `$d.Title = ${psQuote(title)}`,
    "$d.Filter = '插件压缩包 (*.zip)|*.zip|所有文件 (*.*)|*.*'",
    '$d.CheckFileExists = $true',
    '$d.Multiselect = $false',
    'if ($env:WOW_BUTLER_PICK_DEFAULT -and (Test-Path -LiteralPath $env:WOW_BUTLER_PICK_DEFAULT)) { $d.InitialDirectory = $env:WOW_BUTLER_PICK_DEFAULT }',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '  [Console]::Out.WriteLine("OK:" + $d.FileName)',
    '}',
  ].join('; ');
  return runDialog(script, { WOW_BUTLER_PICK_DEFAULT: defaultPath || '' });
}

async function pickSavePath({
  title = '保存文件',
  defaultName = 'profile.wowpack',
  defaultPath = '',
} = {}) {
  if (!isSupported()) {
    throw new AppError('当前系统不支持原生保存对话框，请手动填写路径', 'UNSUPPORTED', 400);
  }
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.SaveFileDialog',
    `$d.Title = ${psQuote(title)}`,
    "$d.Filter = '魔兽插件管家快照 (*.wowpack)|*.wowpack|ZIP 压缩包 (*.zip)|*.zip|所有文件 (*.*)|*.*'",
    `$d.FileName = ${psQuote(defaultName)}`,
    '$d.OverwritePrompt = $true',
    'if ($env:WOW_BUTLER_PICK_DEFAULT -and (Test-Path -LiteralPath $env:WOW_BUTLER_PICK_DEFAULT)) { $d.InitialDirectory = $env:WOW_BUTLER_PICK_DEFAULT }',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '  [Console]::Out.WriteLine("OK:" + $d.FileName)',
    '}',
  ].join('; ');
  return runDialog(script, { WOW_BUTLER_PICK_DEFAULT: defaultPath || '' });
}

module.exports = { pickFolder, pickFile, pickSavePath, isSupported };
