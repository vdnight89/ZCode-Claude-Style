'use strict';

const { runOnce, runWatch } = require('./watch');
const { discover, readBundle } = require('./cdp');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--validate') {
    await readBundle();
    return;
  }
  if (args.length === 1 && args[0] === '--check') {
    const endpoint = await discover();
    if (!endpoint?.pages.length) throw new Error('未找到带调试端口的 ZCode 主窗口');
    console.log(JSON.stringify({ pid: endpoint.pid, port: endpoint.port, source: endpoint.source, windows: endpoint.pages.length }));
    return;
  }
  if (args.some(arg => !['--watch', '--exit-on-host-close'].includes(arg)) ||
      (args.includes('--exit-on-host-close') && !args.includes('--watch'))) {
    throw new Error('用法: node inject.js [--validate | --check | --watch [--exit-on-host-close]]');
  }
  if (args.includes('--watch')) await runWatch(args.includes('--exit-on-host-close'));
  else await runOnce();
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
