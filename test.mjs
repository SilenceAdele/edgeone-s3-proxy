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

pass = show('1. Health check /health', await call('/health'), 200) && pass;
pass = show('2. No extension / disallowed type', await call('/etc/passwd'), 403) && pass;
pass = show('3. Valid signature, object missing', await call('/no/such/file.png'), 404) && pass;

// The landing page fails closed without PROXY_TOKEN, then asks for it.
const page = (path, { tokenEnv = '', headers = {} } = {}) =>
  onRequest({
    request: new Request(BASE + path, { method: 'GET', headers }),
    params: {},
    env: { ...env, PROXY_TOKEN: tokenEnv },
    waitUntil: () => {},
  });

const noToken = await page('/');
const noTokenText = await noToken.text();
pass =
  show('4. " / " without PROXY_TOKEN -> 503', noToken, 503) &&
  !noTokenText.includes('S3 reverse proxy') &&
  pass;

const gated = await page('/', { tokenEnv: 'page-secret' });
const gatedText = await gated.text();
pass =
  show('5. " / " asks for the token', gated, 401) &&
  gatedText.includes('name="token"') &&
  pass;

const wrong = await page('/?token=nope', { tokenEnv: 'page-secret' });
const wrongText = await wrong.text();
pass =
  show('6. wrong token refused, never echoed', wrong, 401) &&
  wrongText.includes('令牌不正确') &&
  !wrongText.includes('nope') &&
  pass;

const good = await page('/?token=page-secret', { tokenEnv: 'page-secret' });
const goodText = await good.text();
const cookie = good.headers.get('set-cookie') || '';
pass =
  show('7. right token renders the landing page', good, 200) &&
  goodText.includes('S3 reverse proxy') &&
  /proxy_access=/.test(cookie) &&
  /HttpOnly/.test(cookie) &&
  !cookie.includes('page-secret') &&
  pass;

const cookieValue = /proxy_access=([^;]+)/.exec(cookie)?.[1] || '';
const byCookie = await page('/', {
  tokenEnv: 'page-secret',
  headers: { cookie: `proxy_access=${cookieValue}` },
});
pass = show('8. the cookie opens the page', byCookie, 200) && pass;

const health = await page('/health', { tokenEnv: 'page-secret' });
pass =
  show('9. health stays public and reports the gate', health, 200) &&
  (await health.text()).includes('pages: protected') &&
  pass;

if (KNOWN_KEY) {
  const r4 = await call('/' + KNOWN_KEY);
  pass = show(`10. Fetch existing object ${KNOWN_KEY}`, r4, 200) && pass;
  if (r4.ok) {
    const ct = r4.headers.get('content-type');
    const len = (await r4.arrayBuffer()).byteLength;
    console.log(`        content-type=${ct}  size=${len}B  cache=${r4.headers.get('x-cache')}`);
    console.log(`        CORS: ${r4.headers.get('access-control-allow-origin')}`);
  }
} else {
  console.log('  SKIP 10. no key supplied (usage: node test.mjs <key>)');
}

// Missing env vars must produce a clear, named error.
const r5 = await onRequest({
  request: new Request(BASE + '/x.png'),
  params: {},
  env: { S3_BUCKET: 'b' },
  waitUntil: () => {},
});
pass = show('11. Missing env vars -> clear error', r5, 500) && pass;
if (r5.status === 500) {
  console.log(`        ${(await r5.text()).split('\n')[0]}`);
}

// The platform routes "/" to functions/index.ts only; keep that file wired up.
const rootEntry = await import('./functions/index.ts');
const sameHandler = rootEntry.onRequest === onRequest;
console.log(`  ${sameHandler ? 'PASS' : 'FAIL'}  12. functions/index.ts points at the same handler`);
pass = sameHandler && pass;

console.log();
console.log(pass ? 'All passed' : 'Some assertions failed');
process.exit(pass ? 0 : 1);
