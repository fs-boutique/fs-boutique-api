const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../netlify/functions/guesty-webhook.js'), 'utf8');

async function run(options = {}) {
  const calls = [];
  const response = (status, body = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const context = {
    exports: {},
    process: { env: { NOTION_TOKEN: 'test-notion', ...(options.withoutBrevo ? {} : { BREVO_API_KEY: 'test-brevo' }) } },
    console: { log() {} },
    fetch: async (url, init) => {
      calls.push({ url, method: init.method });
      if (url.endsWith('/query')) {
        return response(options.lookupStatus || 200, options.invalidLookup ? {} : {
          results: options.existing ? [{ id: 'existing-page', properties: {} }] : [],
        });
      }
      if (url.startsWith('https://api.notion.com/v1/pages')) return response(options.notionStatus || 200);
      if (url === 'https://api.brevo.com/v3/contacts') return response(options.brevoStatus || 201);
      throw new Error(`Unexpected external request: ${url}`);
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const result = await context.exports.handler({
    httpMethod: 'POST', headers: {},
    body: JSON.stringify({ event: 'reservation.updated', data: {
      _id: 'test-reservation', checkIn: '2026-09-15', checkOut: '2026-09-17',
      listing: { nickname: 'FS I Boutique La Quinta' },
      guest: { fullName: 'Test Guest', email: 'guest@example.invalid', phone: '+15555550100', birthday: '2000-01-01' },
    } }),
  });
  return { result, calls };
}

test('rejects a failed Notion lookup without creating a duplicate or writing to Brevo', async () => {
  const { result, calls } = await run({ lookupStatus: 503 });
  assert.equal(result.statusCode, 500);
  assert.equal(calls.filter(c => !c.url.endsWith('/query')).length, 0);
});

test('rejects an invalid lookup response instead of treating it as no existing record', async () => {
  const { result, calls } = await run({ invalidLookup: true });
  assert.equal(result.statusCode, 500);
  assert.equal(calls.filter(c => !c.url.endsWith('/query')).length, 0);
});

test('does not report success or continue to Brevo after a failed Notion create', async () => {
  const { result, calls } = await run({ notionStatus: 429 });
  assert.equal(result.statusCode, 500);
  assert.equal(calls.some(c => c.url.includes('brevo.com')), false);
});

test('does not report success after a failed Notion update', async () => {
  const { result } = await run({ existing: true, notionStatus: 403 });
  assert.equal(result.statusCode, 500);
});

test('does not report a fully successful sync when Brevo rejects the contact', async () => {
  const { result } = await run({ brevoStatus: 400 });
  assert.equal(result.statusCode, 500);
});

test('retains successful creation and synchronization to both destinations', async () => {
  const { result, calls } = await run();
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).synced, true);
  assert.equal(calls.filter(c => c.url.includes('/pages')).length, 1);
  assert.equal(calls.filter(c => c.url.includes('brevo.com')).length, 1);
});

test('retains successful updates without creating another Notion page', async () => {
  const { result, calls } = await run({ existing: true });
  assert.equal(result.statusCode, 200);
  assert.equal(calls.find(c => c.url.includes('/pages')).method, 'PATCH');
});

test('retains the existing optional-Brevo configuration', async () => {
  const { result, calls } = await run({ withoutBrevo: true });
  assert.equal(result.statusCode, 200);
  assert.equal(calls.some(c => c.url.includes('brevo.com')), false);
});
