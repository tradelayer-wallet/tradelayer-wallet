#!/usr/bin/env node
import { createServer } from 'node:http';
import { existsSync, createReadStream } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import CDP from 'chrome-remote-interface';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(__dirname, '..', '..', '..');

function resolveDistDir() {
  const candidates = [
    path.join(packageRoot, 'dist'),
    path.join(repoRoot, 'dist', 'fe'),
    path.join(repoRoot, 'dist'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }
  return candidates[0];
}

const distDir = resolveDistDir();

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PLAYWRIGHT_CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error('No Chrome/Edge executable found. Set CHROME_PATH to a browser executable.');
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function createDistServer(rootDir, port) {
  const indexHtml = path.join(rootDir, 'index.html');
  const server = createServer(async (req, res) => {
    try {
      const rawUrl = req.url || '/';
      const requestPath = decodeURIComponent(rawUrl.split('?')[0]);
      const safePath = requestPath === '/' ? '/index.html' : requestPath;
      const filePath = path.normalize(path.join(rootDir, safePath));
      const normalizedRoot = path.normalize(rootDir + path.sep);
      if (!filePath.startsWith(normalizedRoot)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      try {
        const stat = await access(filePath);
        void stat;
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': mimeTypes.get(ext) || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        createReadStream(filePath).pipe(res);
        return;
      } catch {}

      if (safePath !== '/index.html') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        createReadStream(indexHtml).pipe(res);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(error && error.stack ? error.stack : error));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function spawnChrome(executablePath, debugPort, startUrl, userDataDir) {
  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-extensions',
    '--window-size=1600,1100',
    startUrl,
  ];

  const child = spawn(executablePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  child.unref();
  return child;
}

async function waitForChromePort(port, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const version = await CDP.Version({ port });
      if (version && version.webSocketDebuggerUrl) return version;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Chrome remote debugging port ${port} did not become ready in time`);
}

async function waitForCondition(Runtime, expression, timeoutMs = 20000, intervalMs = 100) {
  const end = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() < end) {
    const result = await Runtime.evaluate({ expression, returnByValue: true });
    lastValue = result && result.result ? result.result.value : null;
    if (lastValue) return lastValue;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${expression} (last=${JSON.stringify(lastValue)})`);
}

async function waitForAbsent(Runtime, expression, timeoutMs = 20000, intervalMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await Runtime.evaluate({ expression, returnByValue: true });
    if (!result || !result.result || !result.result.value) return true;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for absence of: ${expression}`);
}

async function clickSelector(Runtime, Input, selector) {
  const payload = await Runtime.evaluate({
    expression: `
      (function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        var rect = el.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
          disabled: !!el.disabled
        };
      })()
    `,
    returnByValue: true,
  });

  const value = payload && payload.result ? payload.result.value : null;
  if (!value) {
    throw new Error(`Element not found: ${selector}`);
  }
  if (value.disabled) {
    throw new Error(`Element is disabled: ${selector}`);
  }

  await Input.dispatchMouseEvent({ type: 'mouseMoved', x: value.x, y: value.y, button: 'left' });
  await Input.dispatchMouseEvent({ type: 'mousePressed', x: value.x, y: value.y, button: 'left', clickCount: 1 });
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: value.x, y: value.y, button: 'left', clickCount: 1 });
}

async function clickByText(Runtime, Input, selector, textPattern) {
  const payload = await Runtime.evaluate({
    expression: `
      (function() {
        var nodes = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(selector)}));
        var el = nodes.find(function(node) {
          return ${textPattern}.test((node.innerText || node.textContent || '').trim());
        });
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        var rect = el.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
          disabled: !!el.disabled
        };
      })()
    `,
    returnByValue: true,
  });

  const value = payload && payload.result ? payload.result.value : null;
  if (!value) {
    throw new Error(`Element not found for text pattern ${textPattern}`);
  }
  if (value.disabled) {
    throw new Error(`Element is disabled for text pattern ${textPattern}`);
  }

  await Input.dispatchMouseEvent({ type: 'mouseMoved', x: value.x, y: value.y, button: 'left' });
  await Input.dispatchMouseEvent({ type: 'mousePressed', x: value.x, y: value.y, button: 'left', clickCount: 1 });
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: value.x, y: value.y, button: 'left', clickCount: 1 });
}

async function main() {
  if (!existsSync(distDir)) {
    throw new Error(`Missing dist directory at ${distDir}. Run npm run build first.`);
  }

  const httpPort = await getFreePort();
  const debugPort = await getFreePort();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'tlwallet-bench-'));
  const chromePath = resolveChromeExecutable();
  const server = await createDistServer(distDir, httpPort);
  const url = `http://127.0.0.1:${httpPort}/`;
  const chrome = spawnChrome(chromePath, debugPort, url, userDataDir);
  const version = await waitForChromePort(debugPort);
  const client = await CDP({ port: debugPort });
  const { Page, Runtime, Input, Network } = client;

  const consoleMessages = [];
  const pageErrors = [];
  const requests = [];
  Page.enable();
  Runtime.enable();
  Network.enable();

  Runtime.consoleAPICalled(async (params) => {
    try {
      const text = params.args && params.args.length
        ? params.args.map((arg) => (arg.value !== undefined ? String(arg.value) : '')).join(' ')
        : '';
      consoleMessages.push({ type: params.type, text });
    } catch {}
  });

  Runtime.exceptionThrown((params) => {
    pageErrors.push(params && params.exceptionDetails && params.exceptionDetails.text ? params.exceptionDetails.text : 'Unknown page error');
  });

  Network.requestWillBeSent((params) => {
    requests.push({
      url: params.request.url,
      type: params.type,
      timestamp: params.timestamp,
    });
  });

  await Page.addScriptToEvaluateOnNewDocument({
    source: `
      window.__bench = { longTasks: [], marks: [] };
      try {
        new PerformanceObserver(function(list) {
          var entries = list.getEntries();
          for (var i = 0; i < entries.length; i++) {
            window.__bench.longTasks.push({
              name: entries[i].name,
              start: entries[i].startTime,
              duration: entries[i].duration
            });
          }
        }).observe({ entryTypes: ['longtask'] });
      } catch (e) {}
    `,
  });

  const bench = {
    chromePath,
    chromeVersion: version && version.Browser ? version.Browser : null,
    url,
    timings: {},
    browserState: {},
    consoleMessages: [],
    pageErrors: [],
    requests: [],
  };

  const t0 = performance.now();
  await Page.navigate({ url });
  await waitForCondition(Runtime, "document.readyState === 'interactive' || document.readyState === 'complete'", 20000);
  bench.timings.domInteractiveMs = Math.round(performance.now() - t0);

  await waitForCondition(Runtime, "document.querySelector('.nav-container a') !== null", 20000);
  bench.timings.navVisibleMs = Math.round(performance.now() - t0);

  const navMetrics = await Runtime.evaluate({
    expression: `
      (function() {
        var nav = performance.getEntriesByType('navigation')[0];
        return nav ? {
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
          load: Math.round(nav.loadEventEnd - nav.startTime),
          responseEnd: Math.round(nav.responseEnd - nav.startTime)
        } : null;
      })()
    `,
    returnByValue: true,
  });
  bench.browserState.navigation = navMetrics && navMetrics.result ? navMetrics.result.value : null;

  // Startup click benchmark: open Portfolio and wait for the page shell to settle.
  const portfolioClickStart = performance.now();
  await clickByText(Runtime, Input, '.nav-container a[mat-tab-link]', /Portfolio/i);
  await waitForCondition(Runtime, "location.pathname.indexOf('portfolio') !== -1 || document.querySelector('.portfolio-page-container') !== null", 20000);
  await waitForCondition(Runtime, "document.querySelector('.portfolio-page-container') !== null", 20000);
  bench.timings.portfolioOpenMs = Math.round(performance.now() - portfolioClickStart);

  const walletStatus = await Runtime.evaluate({
    expression: `
      (function() {
        var el = document.querySelector('.wallet-bootstrap-status');
        return el ? el.textContent.trim() : '';
      })()
    `,
    returnByValue: true,
  });
  bench.browserState.walletBootstrapStatus = walletStatus && walletStatus.result ? walletStatus.result.value : '';

  // First action button benchmark. If there are no rows yet, record a skip.
  const sendButtons = await Runtime.evaluate({
    expression: "document.querySelectorAll('.portfolio-page-container .action-button[aria-label=\"Send\"]').length",
    returnByValue: true,
  });
  bench.browserState.portfolioSendButtons = sendButtons && sendButtons.result ? sendButtons.result.value : 0;
  if (bench.browserState.portfolioSendButtons > 0) {
    const sendDialogStart = performance.now();
    await clickSelector(Runtime, Input, '.portfolio-page-container .action-button[aria-label="Send"]');
    await waitForCondition(Runtime, "document.querySelector('mat-dialog-container') !== null", 20000);
    bench.timings.portfolioSendDialogMs = Math.round(performance.now() - sendDialogStart);
    await Runtime.evaluate({ expression: "document.querySelector('button[aria-label=\"Close\"],button[aria-label=\"Dismiss\"]') && document.querySelector('button[aria-label=\"Close\"],button[aria-label=\"Dismiss\"]').click()", returnByValue: true }).catch(() => {});
  } else {
    bench.timings.portfolioSendDialogMs = null;
    bench.browserState.portfolioSendDialog = 'skipped (no wallet rows yet)';
  }

  // Dialog click benchmark for the top-level New Address control.
  const newAddressReady = await Runtime.evaluate({
    expression: "!!document.querySelector('.portfolio-page-container .new-address-buttton:not([disabled])')",
    returnByValue: true,
  });
  if (newAddressReady && newAddressReady.result && newAddressReady.result.value) {
    const newAddressStart = performance.now();
    await clickSelector(Runtime, Input, '.portfolio-page-container .new-address-buttton');
    await waitForCondition(Runtime, "document.querySelector('mat-dialog-container') !== null", 20000);
    bench.timings.newAddressDialogMs = Math.round(performance.now() - newAddressStart);
    await Runtime.evaluate({
      expression: `
        (function() {
          var btn = Array.prototype.find.call(document.querySelectorAll('button'), function(el) {
            return /close|cancel/i.test((el.innerText || el.getAttribute('aria-label') || '').trim());
          });
          if (btn) btn.click();
        })()
      `,
      returnByValue: true,
    }).catch(() => {});
  } else {
    bench.timings.newAddressDialogMs = null;
    bench.browserState.newAddressDialog = 'skipped (button disabled or hidden)';
  }

  const homeClickStart = performance.now();
  await clickByText(Runtime, Input, '.nav-container a[mat-tab-link]', /Home/i);
  await waitForAbsent(Runtime, "location.pathname.indexOf('portfolio') !== -1", 20000).catch(() => {});
  bench.timings.homeReturnMs = Math.round(performance.now() - homeClickStart);

  const finalState = await Runtime.evaluate({
    expression: `
      (function() {
        var nav = performance.getEntriesByType('navigation')[0];
        var longTasks = window.__bench && window.__bench.longTasks ? window.__bench.longTasks : [];
        return {
          readyState: document.readyState,
          pathname: location.pathname,
          longTasksCount: longTasks.length,
          maxLongTaskMs: longTasks.length ? Math.max.apply(Math, longTasks.map(function(entry) { return entry.duration; })) : 0,
          longTasks: longTasks.slice(0, 10),
          navigation: nav ? {
            domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
            load: Math.round(nav.loadEventEnd - nav.startTime),
            responseEnd: Math.round(nav.responseEnd - nav.startTime)
          } : null
        };
      })()
    `,
    returnByValue: true,
  });
  bench.browserState = Object.assign(bench.browserState, finalState && finalState.result ? finalState.result.value : {});
  bench.consoleMessages = consoleMessages.slice(0, 40);
  bench.pageErrors = pageErrors;
  bench.requests = requests.slice(0, 80);

  console.log(JSON.stringify(bench, null, 2));

  await client.close().catch(() => {});
  chrome.kill();
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  server.close();
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
