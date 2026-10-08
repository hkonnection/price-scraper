/** Offline loader for actual TSX modules with request and navigation fixtures. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

/**
 * Loads actual application code without Cloudflare or remote I/O.
 * @param {object} options - Synthetic database and retailer selection.
 * @returns {Function} A module loader rooted in src/app.
 */
function appLoader({ db, retailer = 'all' } = {}) {
  const cache = new Map();
  /** Load and transpile one local module, with only platform boundaries stubbed. */
  function load(filename) {
    const absolute = path.resolve(__dirname, '../src/app', filename);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const source = fs.readFileSync(absolute, 'utf8');
    const output = ts.transpileModule(source + (filename.endsWith('page.tsx') ? '\nexport { getData };' : ''), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const module = { exports: {} };
    cache.set(absolute, module);
    vm.runInNewContext(output, {
      module, exports: module.exports, console: { log() {}, error() {} }, process: { env: { NODE_ENV: 'production' } },
      fetch() { throw new Error('Remote I/O denied'); },
      require(name) {
        if (name === '@cloudflare/next-on-pages') return { getRequestContext: () => ({ env: { DB: db } }) };
        if (name === 'next/navigation') return { useSearchParams: () => new URLSearchParams({ retailer }), useRouter: () => ({ replace() {} }) };
        if (name.startsWith('.')) {
          const base = path.resolve(path.dirname(absolute), name);
          const resolved = [base, base + '.ts', base + '.tsx'].find(p => fs.existsSync(p));
          return load(path.relative(path.resolve(__dirname, '../src/app'), resolved));
        }
        return require(name);
      },
    }, { filename: absolute });
    return module.exports;
  }
  return load;
}
module.exports = { appLoader };
