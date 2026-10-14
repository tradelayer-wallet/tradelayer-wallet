'use strict';

// Loads a TypeScript source file for the tests. The file is transpiled in memory with the
// repo's own `typescript` package and evaluated as CommonJS. Nothing is written to disk.
// Relative imports that end in .ts are loaded the same way. Every other import is resolved
// from the importing file, so the package's own node_modules are used. `stubs` replaces a
// named import (for example an Angular module) with the object given. Each call returns a
// fresh module instance, so tests never share state through the module cache.

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const ts = require('typescript');

const REPO = path.resolve(__dirname, '..', '..');

const loadTs = (absFile, stubs = {}) => {
    const file = path.resolve(absFile);
    const source = fs.readFileSync(file, 'utf8');
    const { outputText } = ts.transpileModule(source, {
        fileName: file,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2019,
            esModuleInterop: true,
        },
    });
    const mod = { exports: {} };
    const dir = path.dirname(file);
    const nodeRequire = createRequire(file);
    const localRequire = (request) => {
        if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
        if (request.startsWith('.')) {
            const base = path.resolve(dir, request);
            if (fs.existsSync(`${base}.ts`)) return loadTs(`${base}.ts`, stubs).exports;
            if (fs.existsSync(path.join(base, 'index.ts'))) return loadTs(path.join(base, 'index.ts'), stubs).exports;
        }
        return nodeRequire(request);
    };
    const run = new Function('exports', 'require', 'module', '__filename', '__dirname', outputText);
    run(mod.exports, localRequire, mod, file, dir);
    return mod;
};

module.exports = { loadTs, REPO };
