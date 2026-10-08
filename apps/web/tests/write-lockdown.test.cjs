/**
 * Offline web write-boundary and public-read regressions.
 * Run: node --test apps/web/tests/*.test.cjs
 * Requires Node 22.13+ for isolated SQLite. No remote I/O is available.
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '../../..');
const app = path.join(root, 'apps/web/src/app');

/**
 * Loads actual TS/TSX source and relative modules with isolated request boundaries.
 * @param {string} filename - Source file to evaluate.
 * @param {object} mocks - Explicit dependency and global mocks.
 * @returns {object} CommonJS exports from the real source.
 */
function load(filename, mocks = {}) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, Response, Request, console,
    fetch: mocks.fetch || (() => { throw new Error('Remote I/O forbidden'); }),
    /** Resolve only mocked platform dependencies, React, and local TS/TSX modules. */
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      if (name.startsWith('.')) {
        const base = path.resolve(path.dirname(filename), name);
        const resolved = [base, base + '.ts', base + '.tsx'].find(file => fs.existsSync(file) && fs.statSync(file).isFile());
        if (resolved) return load(resolved, mocks);
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }, { filename });
  return exports;
}

/**
 * Creates synthetic stored deals and a D1 facade with recorded mutations.
 * @returns {object} SQLite database, bindings, and mutation counter.
 */
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'db/schema.sql'), 'utf8'));
  db.exec(`INSERT INTO deals (retailer_id,product_code,product_name,regular_price,sale_price,savings_amount,savings_percent,category,scraped_at)
    SELECT id,'fixture-' || slug,'Synthetic stored ' || slug,100,75,25,25,'Synthetic','2026-01-01T12:00:00Z'
    FROM retailers WHERE is_active=1;`);
  const state = { mutations: 0, dispatches: 0 };
  const facade = {
    prepare(sql) {
      let params = [];
      return {
        bind(...args) { params = args; return this; },
        async all() { assert.match(sql.trim(), /^SELECT/i); return { results: db.prepare(sql).all(...params) }; },
        async first() { assert.match(sql.trim(), /^SELECT/i); return db.prepare(sql).get(...params) || null; },
        async run() { state.mutations++; return db.prepare(sql).run(...params); },
      };
    },
    /** Execute the website's read-only batch without counting SELECT as a mutation. */
    async batch(statements) {
      db.exec('BEGIN');
      try { return await Promise.all(statements.map(statement => statement.all())); }
      finally { db.exec('ROLLBACK'); }
    },
  };
  return { db, state, env: { DB: facade, GITHUB_TOKEN: 'synthetic-not-a-credential' } };
}

for (const [endpoint, body] of [
  ['trigger-scrape', { retailer: 'costco' }],
  ['import-deals', { retailer: 'carters', pulledDate: '2026-01-01', deals: [
    { product_name: 'Synthetic replacement', product_code: 'replacement', regular_price: 100, sale_price: 50 },
  ] }],
]) {
  test(`anonymous valid POST cannot reach ${endpoint}, even with synthetic bindings`, async () => {
    const { db, state, env } = fixture();
    const before = JSON.stringify(db.prepare('SELECT * FROM deals ORDER BY id').all());
    const filename = path.join(app, 'api', endpoint, 'route.ts');
    try {
      // If reintroduced, exercise the handler rather than trusting a hidden button.
      if (fs.existsSync(filename)) {
        const handler = load(filename, {
          '@cloudflare/next-on-pages': { getRequestContext: () => ({ env }) },
          fetch: async () => { state.dispatches++; return new Response(null, { status: 204 }); },
        });
        const response = await handler.POST(new Request(`http://localhost/api/${endpoint}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }));
        assert.equal(response.status, 404, 'Removed public write route must not accept anonymous POST');
      }
      assert.equal(fs.existsSync(filename), false, 'Write handler must remain unregistered');
      assert.deepEqual(state, { mutations: 0, dispatches: 0 });
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM deals ORDER BY id').all()), before);
    } finally { db.close(); }
  });
}

for (const retailer of ['costco', 'carters', 'all']) {
  test(`public ${retailer} browsing renders stored deals without write controls`, async () => {
    const { db, env, state } = fixture();
    try {
      const navigation = {
        useSearchParams: () => new URLSearchParams({ retailer }),
        useRouter: () => ({ replace() {} }),
      };
      const page = load(path.join(app, 'page.tsx'), {
        '@cloudflare/next-on-pages': { getRequestContext: () => ({ env }) },
        'next/navigation': navigation,
      });
      const element = await page.default({ searchParams: Promise.resolve({ retailer }) });
      const html = renderToStaticMarkup(element);
      if (retailer !== 'all') assert.match(html, new RegExp(`Synthetic stored ${retailer}`));
      else {
        assert.match(html, /Synthetic stored costco/);
        assert.match(html, /Synthetic stored carters/);
      }
      assert.doesNotMatch(html, /Import Deals|Refresh Deals|Upload File|Paste JSON|import-button|refresh-button/);
      assert.deepEqual(state, { mutations: 0, dispatches: 0 });
    } finally { db.close(); }
  });
}

test('empty public view does not direct users to the removed import flow', () => {
  const Table = load(path.join(app, 'components/DealsTable.tsx')).default;
  const html = renderToStaticMarkup(React.createElement(Table, { deals: [], lastUpdated: null }));
  assert.match(html, /No deals found/);
  assert.doesNotMatch(html, /import deals/i);
});

test('app has no alternative web write handlers, actions, or dependent component references', () => {
  /** @param {string} directory - App subtree. @returns {string[]} Source paths. */
  function files(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory() ? files(filename) : [filename];
    });
  }
  for (const filename of files(app).filter(file => /\.[jt]sx?$/.test(file))) {
    const source = fs.readFileSync(filename, 'utf8');
    assert.doesNotMatch(source, /trigger-scrape|import-deals|ImportModal|RefreshButton|use server|\/dispatches/);
    assert.doesNotMatch(source, /export\s+(?:async\s+)?function\s+(?:POST|PUT|PATCH|DELETE)\b/);
  }
});

test('existing GitHub manual-run interfaces remain available in source', () => {
  for (const filename of fs.readdirSync(path.join(root, '.github/workflows'))) {
    const source = fs.readFileSync(path.join(root, '.github/workflows', filename), 'utf8');
    assert.match(source, /workflow_dispatch:/);
  }
});
