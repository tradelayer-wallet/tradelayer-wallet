const { spawnSync } = require('child_process');
const { resolve } = require('path');

require('./cleanup-wallet-fe-install-artifacts');

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
const nodeOptions = new Set(
  String(process.env.NODE_OPTIONS || '')
    .split(/\s+/)
    .map((option) => option.trim())
    .filter(Boolean),
);

// Only inject the legacy OpenSSL provider on Node versions that need it and accept it.
// Node 14 rejects this flag in NODE_OPTIONS, which breaks local builds.
if (Number.isFinite(nodeMajor) && nodeMajor >= 17) {
  nodeOptions.add('--openssl-legacy-provider');
}
if (![...nodeOptions].some((option) => option.startsWith('--max_old_space_size='))) {
  nodeOptions.add('--max_old_space_size=4096');
}

const env = {
  ...process.env,
  NODE_OPTIONS: [...nodeOptions].join(' '),
};

const walletFeRoot = resolve(__dirname, '..', 'packages', 'wallet-fe');
const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const buildScript = process.argv.includes('--watch') ? 'build:watch' : 'build';
const args = [
  ...(npmExecPath ? [npmExecPath] : []),
  'run',
  buildScript,
  '--prefix',
  walletFeRoot,
];
const result = spawnSync(
  npmCommand,
  args,
  {
    env,
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
