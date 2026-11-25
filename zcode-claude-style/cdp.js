'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const vm = require('node:vm');

const exec = promisify(execFile);
const defaultExecutable = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ZCode', 'ZCode.exe');
const local = process.env.LOCALAPPDATA;
const candidates = [defaultExecutable];
if (local) candidates.push(path.join(local, 'Programs', 'ZCode', 'ZCode.exe'), path.join(local, 'ZCode', 'ZCode.exe'));
const executable = process.env.ZCODE_CLAUDE_STYLE_EXE || candidates.find(existsSync) || defaultExecutable;
const rendererPath = pathToFileURL(path.join(path.dirname(executable),
  'resources', 'app.asar', 'out', 'renderer', 'index.html')).pathname.toLowerCase();
const portFile = path.join(process.env.APPDATA || '', 'ZCode', 'session', 'DevToolsActivePort');
const browserPathPattern = /^\/devtools\/browser\/[a-f0-9-]{36}$/i;
const pageIdPattern = /^[a-f0-9]{32}$/i;
let verifiedBrowser;
let previousFallbackPort;
let nextScanAt = 0;

async function jsonEndpoint(port, name) {
  const response = await fetch('http://127.0.0.1:' + port + '/json/' + name, {
    redirect: 'error',
    signal: AbortSignal.timeout(1400),
  });
  if (!response.ok) throw new Error('CDP HTTP ' + response.status);
  return response.json();
}

async function tcpListeners() {
  const { stdout } = await exec('netstat.exe', ['-ano', '-p', 'tcp'], {
    windowsHide: true, timeout: 4000,
  });
  // Windows reports an unspecified remote endpoint on IPv4 listening sockets.
  return stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(([protocol, , remote]) => protocol === 'TCP' && remote === '0.0.0.0:0')
    .map(([, local, , , pid]) => {
      const [host, port] = local.split(':');
      return { host, port: Number(port), pid: Number(pid) };
    });
}

async function zcodePids() {
  const query = '$items = @(Get-Process -Name ZCode -ErrorAction SilentlyContinue | ' +
    'Select-Object Id,Path); ConvertTo-Json -InputObject $items -Compress';
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    windowsHide: true, timeout: 4500,
  });
  const processes = JSON.parse(stdout);
  return new Set(processes
    .filter(info => info.Path?.toLowerCase() === executable.toLowerCase())
    .map(info => info.Id));
}

function listenerPid(port, listeners, owners) {
  const matching = listeners.filter(listener => listener.port === port);
  if (matching.length !== 1 || matching[0].host !== '127.0.0.1') return null;
  return owners.has(matching[0].pid) ? matching[0].pid : null;
}

function isRenderer(target) {
  if (target.type !== 'page' || !pageIdPattern.test(target.id || '')) return false;
  try {
    const url = new URL(target.url);
    return url.protocol === 'file:' && !url.host && url.pathname.toLowerCase() === rendererPath;
  } catch {
    return false;
  }
}

async function findEndpoint(port, source, { expectedPath, listeners, owners } = {}) {
  let version, targets;
  try {
    [version, targets] = await Promise.all([jsonEndpoint(port, 'version'), jsonEndpoint(port, 'list')]);
  } catch {
    return null;
  }
  const base = 'ws://127.0.0.1:' + port;
  const ws = version?.webSocketDebuggerUrl;
  const browserPath = typeof ws === 'string' && ws.startsWith(base + '/') ? ws.slice(base.length) : '';
  if (typeof version?.['User-Agent'] !== 'string' || !version['User-Agent'].includes(' ZCode/') ||
      !browserPathPattern.test(browserPath) || expectedPath && browserPath !== expectedPath ||
      !Array.isArray(targets)) return null;

  const identity = port + browserPath;
  if (verifiedBrowser?.identity !== identity) {
    if (!listeners || !owners) [listeners, owners] = await Promise.all([tcpListeners(), zcodePids()]);
    const pid = listenerPid(port, listeners, owners);
    if (!pid) return null;
    verifiedBrowser = { identity, pid };
  }
  return {
    identity,
    port,
    source,
    pid: verifiedBrowser.pid,
    pages: targets.filter(isRenderer).map(target => ({
      id: target.id,
      ws: base + '/devtools/page/' + target.id,
    })),
  };
}

async function discover() {
  let activePort = '';
  try {
    activePort = await fs.readFile(portFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const [portLine, browserPath] = activePort.trim().split(/\r?\n/);
  const port = Number(portLine);
  if (/^\d{1,5}$/.test(portLine) && port > 0 && port <= 65535 &&
      browserPathPattern.test(browserPath || '')) {
    const endpoint = await findEndpoint(port, 'port-file', { expectedPath: browserPath });
    if (endpoint) return endpoint;
  }

  if (previousFallbackPort) {
    const endpoint = await findEndpoint(previousFallbackPort, 'listen-scan');
    if (endpoint) return endpoint;
    previousFallbackPort = undefined;
  }

  if (Date.now() < nextScanAt) return null;
  nextScanAt = Date.now() + 2000;
  const [listeners, owners] = await Promise.all([tcpListeners(), zcodePids()]);
  for (const candidate of listeners) {
    if (candidate.host !== '127.0.0.1' || !listenerPid(candidate.port, listeners, owners)) continue;
    const endpoint = await findEndpoint(candidate.port, 'listen-scan', { listeners, owners });
    if (endpoint) {
      previousFallbackPort = candidate.port;
      return endpoint;
    }
  }
  return null;
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.events = new Map();
    ws.addEventListener('message', ({ data }) => {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      for (const handler of this.events.get(message.method) || []) handler(message.params);
      const command = this.pending.get(message.id);
      if (!command) return;
      this.pending.delete(message.id);
      clearTimeout(command.timer);
      if (message.error) command.reject(new Error(message.error.message));
      else command.resolve(message.result);
    });
    ws.addEventListener('close', () => this.close());
    ws.addEventListener('error', () => this.close());
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      function fail() {
        clearTimeout(timer);
        ws.close();
        reject(new Error('无法连接 ZCode 页面 CDP'));
      }
      const timer = setTimeout(fail, 2500);
      ws.addEventListener('error', fail, { once: true });
      ws.addEventListener('close', fail, { once: true });
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        ws.removeEventListener('error', fail);
        ws.removeEventListener('close', fail);
        resolve(new CdpSession(ws));
      }, { once: true });
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 已断开'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 命令超时 ' + method));
      }, 3500);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, handler) {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method).push(handler);
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP 已断开'));
    }
    this.pending.clear();
    this.events.clear();
    this.ws.close();
  }
}

function cleanPage() {
  const stack = globalThis.__zcCsCleanups;
  if (Array.isArray(stack)) {
    while (stack.length) {
      try { stack.pop()(); } catch (error) { console.error('[zcode-claude-style] cleanup', error); }
    }
  }
  delete globalThis.__zcCsCleanups;
  delete globalThis.__zcClaudeStyle;
  const style = document.getElementById('zcode-claude-style-css');
  style?.remove();
  return { removedStyle: !!style };
}

const clean = '(' + cleanPage.toString() + ')()';
const runtimeCores = ['runtime/mascot-core.js', 'runtime/ripple-core.js', 'runtime/hud-data.js'];
const bundleFiles = ['config.json', 'selectors.json', 'style.css', ...runtimeCores,
  'runtime/mascot.js', 'runtime/ripple.js', 'runtime/hud.js', 'runtime/main.js'];
let cachedBundle;
let cachedSignature;

async function readBundle() {
  const paths = bundleFiles.map(name => path.join(__dirname, name));
  const glmAsset = path.join(__dirname, 'assets', 'glm-mascot.webp');
  const crabAsset = path.join(__dirname, 'runtime', 'crab-assets.js');
  const crabPresent = existsSync(crabAsset);
  const assetPaths = crabPresent ? [glmAsset, crabAsset] : [glmAsset];
  const stats = await Promise.all([...paths, ...assetPaths].map(file => fs.stat(file, { bigint: true })));
  const signature = stats.map(stat => stat.mtimeNs + ':' + stat.size).join(';');
  if (signature === cachedSignature) return cachedBundle;
  const files = await Promise.all(paths.map(file => fs.readFile(file, 'utf8')));
  const [configJson, selectorsJson, css, ...runtime] = files;
  const config = JSON.parse(configJson);
  const selectors = JSON.parse(selectorsJson);
  if (!['crab', 'glm', 'off'].includes(config.mascot) || typeof config.homeRipple !== 'boolean' ||
      typeof config.theme !== 'boolean') throw new Error('config.json 的 mascot、homeRipple 或 theme 无效');

  if (config.tokenHud !== undefined && typeof config.tokenHud !== 'boolean') {
    throw new Error('config.json 的 tokenHud 必须是布尔值');
  }

  if (config.mascot === 'crab' && !crabPresent) {
    throw new Error('此分享包使用 GLM 娘素材，请将 config.json 的 mascot 设为 glm 或 off。');
  }
  const glmImage = config.mascot === 'glm' ? await fs.readFile(glmAsset, 'base64') : '';
  const crabModule = config.mascot === 'crab' ? await fs.readFile(crabAsset, 'utf8') : '';
  const hash = createHash('sha256').update(JSON.stringify([files, glmImage, crabModule])).digest('hex');

  function inject(hash, config, selectors, css, mountRuntime, remove, expectedPath) {
    if (window !== window.top || location.protocol !== 'file:' || location.host ||
        location.pathname.toLowerCase() !== expectedPath) return null;
    if (globalThis.__zcClaudeStyle?.hash === hash) return globalThis.__zcClaudeStyle.state();
    remove();
    const cleanups = globalThis.__zcCsCleanups = [];
    const styleId = 'zcode-claude-style-css';
    const state = () => ({
      hash, cssLength: document.getElementById(styleId)?.textContent.length || 0,
    });
    globalThis.__zcClaudeStyle = { hash, state };

    function mount() {
      try {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = css;
        document.head.append(style);
        cleanups.push(() => style.remove());
        mountRuntime(config, selectors, cleanups);
      } catch (error) {
        remove();
        throw error;
      }
    }
    if (document.head && document.body) mount();
    else {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
      cleanups.push(() => document.removeEventListener('DOMContentLoaded', mount));
    }
    return state();
  }

  // The reference modules support CommonJS. Keep their exports scoped to this injection.
  const names = ['mascotCore', 'rippleCore', 'hudData'];
  const scoped = (name, source) => 'const ' + name +
    ' = (() => { const module = { exports: {} };\n' + source + '\nreturn module.exports; })();';
  const cores = names.map((name, i) => scoped(name, runtime[i]));
  cores.push(crabModule ? scoped('crabAssets', crabModule) : 'const crabAssets = null;');
  const parameters = [hash, config, selectors, css].map(value => JSON.stringify(value));
  parameters.push('(config, selectors, cleanups) => {\n' +
    ['const glmMascotImage = ' + JSON.stringify(glmImage ? 'data:image/webp;base64,' + glmImage : '') + ';',
      ...cores, ...runtime.slice(names.length)].join('\n') + '\n}',
    cleanPage.toString(), JSON.stringify(rendererPath));
  const expression = '(' + inject.toString() + ')(' + parameters.join(',') + ')';
  // Reject partially written or invalid JS before replacing a working injection.
  new vm.Script(expression);
  cachedSignature = signature;
  cachedBundle = { expression, hash };
  return cachedBundle;
}

async function writeFileAtomic(file, content) {
  const temp = file + '.' + process.pid + '.tmp';
  try {
    await fs.writeFile(temp, content, { flag: 'wx' });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

module.exports = { CdpSession, clean, discover, readBundle, writeFileAtomic };
