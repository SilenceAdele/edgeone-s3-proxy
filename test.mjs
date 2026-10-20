/**
 * Local verification of functions/[[...path]].ts signing and UA logic.
 *
 * Calls onRequest() directly so the real EdgeOne code path is exercised,
 * instead of re-implementing the signature separately (which would drift).
 *
 * Run:
 *   node test.mjs <an-object-key-that-exists-in-the-bucket>
 *
 * Credentials are read from ~/.config/imgup.conf (local file, never committed, never printed).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

// Node 23+ strips TypeScript types natively.
const { onRequest } = await import('./functions/[[...path]].ts');

const conf = {};
for (const line of readFileSync(`${homedir()}/.config/imgup.conf`, 'utf8').split('\n')) {
  const i = line.indexOf('=');
  if (i > 0 && !line.startsWith('#')) conf[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

const env = {
  AWS_ACCESS_KEY_ID: conf.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: conf.AWS_SECRET_ACCESS_KEY,
  S3_BUCKET: conf.BUCKET,
  S3_ENDPOINT: conf.ENDPOINT_HOST,
  S3_REGION: conf.REGION || 'cn-north-1',
  UA_PREFIX: conf.UA || 'S3Drive',
};

const BASE = 'https://img.example.com';
const KNOWN_KEY = process.argv[2] || process.env.KNOWN_KEY || '';

// Node has no `caches` global; stub the minimum the function needs.
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

async function call(path, { method = 'GET', ua = 'Mozilla/5.0' } = {}) {
  const request = new Request(BASE + path, { method, headers: { 'User-Agent': ua } });
  return onRequest({ request, params: {}, env, waitUntil: () => {} });
}

function show(label, res, expect) {
  const ok = res.status === expect;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${String(res.status).padEnd(4)} (expected ${expect})`,
  );
  return ok;
}

console.log(`bucket: ${env.S3_BUCKET}   endpoint: ${env.S3_ENDPOINT}\n`);

let pass = true;

pass = show('1. Health check /', await call('/'), 200) && pass;
pass = show('2. No extension / disallowed type', await call('/etc/passwd'), 403) && pass;
pass = show('3. Valid signature, object missing', await call('/no/such/file.png'), 404) && pass;

if (KNOWN_KEY) {
  const r4 = await call('/' + KNOWN_KEY);
  pass = show(`4. Fetch existing object ${KNOWN_KEY}`, r4, 200) && pass;
  if (r4.ok) {
    const ct = r4.headers.get('content-type');
    const len = (await r4.arrayBuffer()).byteLength;
    console.log(`        content-type=${ct}  size=${len}B  cache=${r4.headers.get('x-cache')}`);
    console.log(`        CORS: ${r4.headers.get('access-control-allow-origin')}`);
  }
} else {
  console.log('  SKIP  4. no key supplied (usage: node test.mjs <key>)');
}

// Missing env vars must produce a clear, named error.
const r5 = await onRequest({
  request: new Request(BASE + '/x.png'),
  params: {},
  env: { S3_BUCKET: 'b' },
  waitUntil: () => {},
});
pass = show('5. Missing env vars -> clear error', r5, 500) && pass;
if (r5.status === 500) {
  console.log(`        ${(await r5.text()).split('\n')[0]}`);
}

console.log();
console.log(pass ? 'All passed' : 'Some assertions failed');
process.exit(pass ? 0 : 1);
