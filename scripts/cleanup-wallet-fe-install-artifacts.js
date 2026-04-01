const { rmSync, readdirSync, statSync } = require('fs');
const { resolve, join } = require('path');

const allowedFiles = new Set([
  '.browserslistrc',
  'angular.json',
  'package-lock.json',
  'package.json',
  'tsconfig.app.json',
  'tsconfig.json',
]);

function main() {
  const walletFeRoot = resolve(__dirname, '..', 'packages', 'wallet-fe');

  for (const entry of readdirSync(walletFeRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (allowedFiles.has(entry.name)) continue;

    const target = join(walletFeRoot, entry.name);
    try {
      const stat = statSync(target);
      if (stat.isFile() || stat.isSymbolicLink()) {
        rmSync(target, { force: true });
      }
    } catch {
      // Ignore entries that disappear while we are cleaning.
    }
  }
}

main();
