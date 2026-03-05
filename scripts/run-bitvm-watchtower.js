/**
 * Desktop wallet wrapper for TradeLayer BitVM watchtower harness.
 *
 * Defaults protocol repo to C:\projects\tradelayer.js, override with:
 *   TL_PROTOCOL_REPO=<path>
 */

const path = require('path');
const { spawnSync } = require('child_process');

function resolveProtocolRepo() {
  return process.env.TL_PROTOCOL_REPO || 'C:\\projects\\tradelayer.js';
}

function main() {
  const repo = resolveProtocolRepo();
  const args = process.argv.slice(2);
  const runner = path.join(repo, 'tests', 'bitvmWatchtowerLive.js');
  const cmdArgs = [runner, ...args];

  const res = spawnSync(process.execPath, cmdArgs, {
    cwd: repo,
    env: process.env,
    stdio: 'inherit'
  });

  process.exit(Number(res.status || 0));
}

main();
