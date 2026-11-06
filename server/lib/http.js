'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { AppError } = require('./errors');
const { sleep, safeFileName } = require('./utils');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

async function fetchResponse(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = 30000,
    retries = 1,
    signal,
  } = options;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept: '*/*',
          ...headers,
        },
        body,
        redirect: 'follow',
        signal: signal || timeoutSignal(timeout),
      });
      if (response.status >= 500 && attempt < retries) {
        lastError = new AppError(`服务器暂时不可用（HTTP ${response.status}）`, 'UPSTREAM_5XX', 502);
        await sleep(700 * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await sleep(700 * (attempt + 1));
    }
  }
  if (lastError instanceof AppError) throw lastError;
  const message =
    lastError?.name === 'TimeoutError' || lastError?.name === 'AbortError'
      ? '网络请求超时，请检查网络后重试'
      : `网络请求失败：${lastError?.message || '未知错误'}`;
  throw new AppError(message, 'NETWORK_ERROR', 502);
}

async function fetchJson(url, options = {}) {
  const response = await fetchResponse(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (!response.ok) {
      const raw = text
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
      throw new AppError(
        raw || `接口请求失败（HTTP ${response.status}）`,
        response.status === 403 ? 'UPSTREAM_FORBIDDEN' : 'UPSTREAM_ERROR',
        response.status === 404 ? 404 : 502,
        { status: response.status, url },
      );
    }
    throw new AppError(`接口返回了无法解析的数据（HTTP ${response.status}）`, 'BAD_JSON', 502);
  }
  if (!response.ok) {
    const message =
      data?.message || data?.error || data?.msg || `接口请求失败（HTTP ${response.status}）`;
    const code = response.status === 403 ? 'UPSTREAM_FORBIDDEN' : 'UPSTREAM_ERROR';
    throw new AppError(message, code, response.status === 404 ? 404 : 502, {
      status: response.status,
      url,
    });
  }
  return data;
}

async function fetchText(url, options = {}) {
  const response = await fetchResponse(url, {
    ...options,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new AppError(`页面请求失败（HTTP ${response.status}）`, 'UPSTREAM_ERROR', 502, { url });
  }
  return text;
}

async function downloadFile(url, destination, options = {}) {
  const { onProgress, maxBytes = 600 * 1024 * 1024, headers = {}, signal } = options;
  const response = await fetchResponse(url, {
    headers: { Accept: 'application/octet-stream,*/*', ...headers },
    timeout: 600000,
    retries: 2,
    signal,
  });
  if (!response.ok) {
    throw new AppError(`下载失败（HTTP ${response.status}）`, 'DOWNLOAD_ERROR', 502, { url });
  }
  const total = Number(response.headers.get('content-length')) || 0;
  if (total > maxBytes) {
    throw new AppError('文件体积超过安全限制，已取消下载', 'FILE_TOO_LARGE', 413);
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const tempPath = `${destination}.part`;
  const handle = await fsp.open(tempPath, 'w');
  let received = 0;
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > maxBytes) {
          throw new AppError('文件体积超过安全限制，已取消下载', 'FILE_TOO_LARGE', 413);
        }
        await handle.write(chunk);
        if (onProgress) {
          onProgress({ received, total, percent: total ? Math.min(100, (received / total) * 100) : 0 });
        }
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      received = buffer.length;
      await handle.write(buffer);
      if (onProgress) onProgress({ received, total: received, percent: 100 });
    }
  } catch (error) {
    await handle.close();
    await fsp.rm(tempPath, { force: true });
    throw error;
  }
  await handle.close();
  await fsp.rename(tempPath, destination);
  return { path: destination, size: received, contentType: response.headers.get('content-type') };
}

function inferFileName(url, fallback = 'addon.zip') {
  try {
    const parsed = new URL(url);
    const base = path.basename(decodeURIComponent(parsed.pathname));
    return safeFileName(base || fallback, fallback);
  } catch {
    return safeFileName(fallback, 'addon.zip');
  }
}

module.exports = {
  DEFAULT_UA,
  fetchResponse,
  fetchJson,
  fetchText,
  downloadFile,
  inferFileName,
  timeoutSignal,
};
