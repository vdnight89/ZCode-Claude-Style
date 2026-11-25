'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { CdpSession, clean, discover, readBundle, writeFileAtomic } = require('./cdp');

const leaseName = createHash('sha256').update(__dirname.toLowerCase()).digest('hex').slice(0, 24);
const pipe = '\\\\.\\pipe\\zcode-claude-style-' + leaseName;
const pidFile = path.join(__dirname, '.watch.pid');
const interval = 450;

function acquireLease(onStop) {
  const server = net.createServer(socket => {
    socket.on('error', () => socket.destroy());
    socket.setTimeout(3000, () => socket.destroy());
    socket.once('data', data => {
      if (!onStop || data.toString() !== 'stop\n') {
        socket.end('busy\n');
        return;
      }
      socket.setTimeout(0);
      onStop(socket);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', error => {
      if (error.code === 'EADDRINUSE') reject(new Error('样式工具已在运行'));
      else reject(error);
    });
    server.listen(pipe, () => resolve(server));
  });
}

function requestStop() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    socket.setEncoding('utf8');
    socket.setTimeout(18000, () => socket.destroy(new Error('等待注入看护退出超时')));
    socket.once('connect', () => socket.write('stop\n'));
    let reply = '';
    socket.on('data', data => { reply += data; });
    socket.once('error', error => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
    socket.once('end', () => {
      if (reply === 'stopped\n') resolve();
      else reject(new Error('样式工具正忙，请等当前命令结束后再卸载'));
    });
  });
}

async function visitPages(endpoint, callback) {
  const results = await Promise.allSettled(endpoint.pages.map(async page => {
    const session = await CdpSession.connect(page.ws);
    try {
      return await callback(session);
    } finally {
      session.close();
    }
  }));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new Error(failures.map(result => result.reason.message).join('；'));
  return results.map(result => result.value);
}

async function runOnce() {
  const lease = await acquireLease();
  try {
    const endpoint = await discover();
    if (!endpoint?.pages.length) throw new Error('未找到带调试端口的 ZCode 主窗口');
    const { expression } = await readBundle();
    const results = await visitPages(endpoint, session => session.evaluate(expression));
    if (results.some(result => !result)) throw new Error('ZCode 主窗口正在切换，请稍后重试');
    for (const result of results) console.log(JSON.stringify(result));
  } finally {
    lease.close();
  }
}

async function apply(entry, bundle) {
  const { session } = entry;
  const { identifier } = await session.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle.expression });
  entry.scripts.add(identifier);
  for (const previous of entry.scripts) {
    if (previous === identifier) continue;
    await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: previous });
    entry.scripts.delete(previous);
  }
  const state = await session.evaluate(bundle.expression);
  if (!state) throw new Error('ZCode 主窗口正在切换');
  entry.hash = bundle.hash;
  console.log('已注入 ' + entry.id + '，样式字符数 ' + state.cssLength);
}

async function disconnect(entry) {
  try {
    if (!entry.session.closed) {
      for (const identifier of entry.scripts) {
        await entry.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
      }
      await entry.session.evaluate(clean);
    }
  } catch (error) {
    if (!entry.session.closed) console.error(error.message);
  } finally {
    entry.session.close();
  }
}

async function runWatch(exitOnHostClose) {
  const clients = [];
  const entries = new Map();
  const cancelled = new AbortController();
  const stop = () => cancelled.abort();
  const lease = await acquireLease(client => {
    clients.push(client);
    stop();
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let host;
  let previousDiscoveryError;
  let previousReadError;
  let bundle;
  const deadline = Date.now() + 60000;

  try {
    await writeFileAtomic(pidFile, process.pid + '\n');
    console.log('等待 ZCode 主窗口与文件更新');
    while (!cancelled.signal.aborted) {
      if (exitOnHostClose && host && !isAlive(host)) break;
      try {
        bundle = await readBundle();
        previousReadError = undefined;
      } catch (error) {
        if (error.message !== previousReadError) console.error(error.message);
        previousReadError = error.message;
      }

      try {
        const endpoint = await discover();
        if (endpoint) host = endpoint.pid;
        if (!host && exitOnHostClose && Date.now() >= deadline) break;

        const livePages = new Map((endpoint?.pages || []).map(page => [page.id, page]));
        for (const [id, entry] of entries) {
          if (entry.session.closed || endpoint && (!livePages.has(id) || entry.identity !== endpoint.identity)) {
            await disconnect(entry);
            entries.delete(id);
          }
        }
        if (bundle && endpoint) {
          for (const page of endpoint.pages) {
            if (cancelled.signal.aborted) break;
            let entry = entries.get(page.id);
            if (!entry) {
              entry = { id: page.id, identity: endpoint.identity, scripts: new Set(),
                session: await CdpSession.connect(page.ws) };
              entries.set(page.id, entry);
            }
            if (entry.hash !== bundle.hash) await apply(entry, bundle);
          }
        }
        previousDiscoveryError = undefined;
      } catch (error) {
        if (error.message !== previousDiscoveryError) console.error(error.message);
        previousDiscoveryError = error.message;
      }
      await delay(interval, undefined, { signal: cancelled.signal }).catch(() => {});
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await Promise.all([...entries.values()].map(entry => disconnect(entry)));
    try {
      await fs.rm(pidFile, { force: true });
    } finally {
      lease.close();
      for (const client of clients) client.end('stopped\n');
    }
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function remove() {
  await requestStop();
  const lease = await acquireLease();
  try {
    const endpoint = await discover();
    if (!endpoint) return 0;
    return (await visitPages(endpoint, session => session.evaluate(clean))).length;
  } finally {
    lease.close();
  }
}

module.exports = { remove, runOnce, runWatch };
