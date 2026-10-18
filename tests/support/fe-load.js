'use strict';

// Loads wallet-fe Angular sources for tests without Angular. Decorators become identity functions, and
// every import that a test needs at run time is given as a stub (the constructors take plain fakes).
// Type-only imports are erased by the transpiler, so they need no stub.

const path = require('path');
const { loadTs, REPO } = require('./ts-loader');

const APP = path.join(REPO, 'packages', 'wallet-fe', 'src', 'app');

const angularCore = {
    Component: () => (target) => target,
    Injectable: () => (target) => target,
    Inject: () => () => {},
};

const loadApp = (relPath, stubs = {}) => loadTs(path.join(APP, relPath), { '@angular/core': angularCore, ...stubs }).exports;

module.exports = { APP, angularCore, loadApp };
