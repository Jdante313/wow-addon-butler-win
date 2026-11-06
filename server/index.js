'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startServer } = require('./app');
const { DATA_DIR, APP_NAME, ensureDirs } = require('./config');

function openBrowser(url) {
  if (process.platform === 'darwin') {
    spawn('/usr/bin/open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function watchParent() {
  const parentPid = Number(process.env.WOW_BUTLER_PARENT_PID || 0);
  if (!parentPid) return;
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, 5000);
  timer.unref();
}

async function main() {
  ensureDirs();
  watchParent();
  const preferred = Number(process.env.PORT ?? (process.argv[2] || 17321));
  const { server, port, url } = await startServer({ port: preferred });
  fs.writeFileSync(
    path.join(DATA_DIR, 'runtime.json'),
    JSON.stringify({ pid: process.pid, port, url, startedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
  // The native macOS shell reads this line to know when the UI is ready.
  console.log(`WOW_BUTLER_READY ${url}`);
  console.log(`${APP_NAME} 已启动：${url}`);
  if (process.env.WOW_BUTLER_NO_OPEN !== '1') openBrowser(url);
  const shutdown = () => {
    try {
      fs.rmSync(path.join(DATA_DIR, 'runtime.json'), { force: true });
    } catch {
      // ignore
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
