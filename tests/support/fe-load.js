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

// A FormGroup stand-in with the members the cards use: value, controls[k].value and setValue, reset.
const formGroup = (init) => {
    const group = { value: { ...init }, controls: {}, valid: true };
    for (const key of Object.keys(init)) {
        group.controls[key] = {
            get value() { return group.value[key]; },
            setValue(v) { group.value[key] = v; },
        };
    }
    group.reset = () => { for (const key of Object.keys(init)) group.value[key] = null; };
    return group;
};

module.exports.formGroup = formGroup;
