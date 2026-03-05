/**
 * Desktop wallet wrapper for TradeLayer BitVM Plan A live harness.
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
  const forwardedArgs = [];
  let requireBundle = false;
  let bundlePath = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--require-bundle') {
      requireBundle = true;
      continue;
    }
    if (arg === '--bundle-path') {
      bundlePath = String(args[i + 1] || '');
      i += 1;
      continue;
    }
    if (arg.startsWith('--bundle-path=')) {
      bundlePath = arg.slice('--bundle-path='.length);
      continue;
    }
    forwardedArgs.push(arg);
  }

  const runner = path.join(repo, 'tests', 'tx30BitvmPlanAMatrix.js');
  const cmdArgs = [runner, ...forwardedArgs];
  const env = { ...process.env };
  if (requireBundle) env.TL_BITVM_REQUIRE_BUNDLE = '1';
  if (bundlePath) env.TL_BITVM_BUNDLE_PATH = bundlePath;

  const res = spawnSync(process.execPath, cmdArgs, {
    cwd: repo,
    env,
    stdio: 'inherit'
  });

  process.exit(Number(res.status || 0));
}

main();
