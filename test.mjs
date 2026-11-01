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
const mod = await import('./functions/[[...path]].ts');
const { onRequest } = mod;

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

// ---- Hotlink protection: pure helpers ----
const parseSample = mod.parseWhitelist('https://Blog.Example.com/, blog2.example.com:8080 ,');
const parseOk =
  JSON.stringify(parseSample) === JSON.stringify(['blog.example.com', 'blog2.example.com:8080']) &&
  mod.parseWhitelist('').length === 0 &&
  mod.parseWhitelist(undefined).length === 0;
console.log(`  ${parseOk ? 'PASS' : 'FAIL'}  10. whitelist parsing (scheme/case/path/port)`);
pass = parseOk && pass;

const list = ['blog.example.com', 'localhost:5173'];
const refDecision = (referer) =>
  mod.refererDecision(
    new Request(BASE + '/a.png', { headers: referer === null ? {} : { referer } }),
    list,
  );
const refCases = [
  [null, 'direct', 'no Referer needs the token'],
  ['https://blog.example.com/post/1', 'allow', 'whitelisted host'],
  ['HTTPS://BLOG.EXAMPLE.COM/', 'allow', 'host is case-insensitive'],
  ['https://evil.example.com/', 'block', 'other site'],
  ['https://blog.example.com.evil.com/', 'block', 'suffix look-alike'],
  ['https://localhost:5173/', 'allow', 'localhost with port'],
  ['http://localhost/', 'block', 'localhost without port'],
  ['not a url', 'direct', 'malformed Referer is not trusted'],
];
const refFails = refCases.filter(([ref, want]) => refDecision(ref) !== want);
console.log(
  `  ${refFails.length ? 'FAIL' : 'PASS'}  11. refererDecision ${refCases.length} cases` +
    (refFails.length ? `  failed: ${refFails.map((c) => c[2]).join(', ')}` : ''),
);
pass = !refFails.length && pass;

// ---- Object access control: end-to-end through handle() ----
const guardCall = (path, referer, { whitelist = 'blog.example.com', token = 'obj-secret', headers = {} } = {}) =>
  onRequest({
    request: new Request(BASE + path, {
      headers: {
        ...(referer === null ? {} : { referer }),
        ...headers,
      },
    }),
    params: {},
    env: { ...env, PROXY_TOKEN: token, IMG_REFERER_WHITELIST: whitelist },
    waitUntil: () => {},
  });

// Both rejections answer with the same generic body.
const generic = async (res) => (await res.text()) === 'Forbidden access';

const blocked = await guardCall('/no/such/file.png', 'https://evil.example.com/');
const blockedBody = await generic(blocked);
pass = show('12. other sites blocked before S3 lookup', blocked, 403) && blockedBody && pass;

const sameSite = await guardCall('/no/such/file.png', 'https://blog.example.com/post');
pass = show('13. whitelisted Referer reaches upstream', sameSite, 404) && pass;

const directNoToken = await guardCall('/no/such/file.png', null);
const directNoTokenBody = await generic(directNoToken);
pass =
  show('14. direct open without token -> 401', directNoToken, 401) &&
  directNoTokenBody &&
  directNoToken.headers.get('cache-control') === 'no-store' &&
  pass;

const directWrong = await guardCall('/no/such/file.png?token=wrong', null);
const wrongBody = await directWrong.text();
pass =
  show('15. wrong token refused, never echoed', directWrong, 401) &&
  wrongBody === 'Forbidden access' &&
  !wrongBody.includes('wrong') &&
  !/token/i.test(wrongBody) &&
  pass;

const directRight = await guardCall('/no/such/file.png?token=obj-secret', null);
pass = show('16. direct open with the token reaches upstream', directRight, 404) && pass;

const cookieHash = await mod.sha256Hex('obj-secret');
const directCookie = await guardCall('/no/such/file.png', null, {
  headers: { cookie: `proxy_access=${encodeURIComponent(cookieHash)}` },
});
pass = show('17. token cookie also opens direct access', directCookie, 404) && pass;

const blockedWithToken = await guardCall(
  '/no/such/file.png?token=obj-secret',
  'https://evil.example.com/',
);
pass = show('18. other sites stay blocked even with a token', blockedWithToken, 403) && pass;

const off = await guardCall('/no/such/file.png', 'https://evil.example.com/', { whitelist: '' });
pass = show('19. empty whitelist disables the check', off, 404) && pass;

const noTokenConfigured = await guardCall('/no/such/file.png', null, { token: '' });
pass = show('20. direct open fails closed without PROXY_TOKEN', noTokenConfigured, 401) && pass;

const healthHotlink = await guardCall('/health', null, {
  whitelist: ' Blog.Example.com , www.example.com ',
});
const healthText = await healthHotlink.text();
pass =
  show('21. health reports the whitelist as a count', healthHotlink, 200) &&
  healthText.includes('hotlink: on (2 hosts)') &&
  healthText.includes('direct: token') &&
  !healthText.includes('example.com') &&
  pass;

const healthOff = await guardCall('/health', null, { whitelist: '' });
pass =
  show('22. health reports hotlink: off', healthOff, 200) &&
  (await healthOff.text()).includes('hotlink: off\n') &&
  pass;

if (KNOWN_KEY) {
  const r4 = await call('/' + KNOWN_KEY);
  pass = show(`23. Fetch existing object ${KNOWN_KEY}`, r4, 200) && pass;
  if (r4.ok) {
    const ct = r4.headers.get('content-type');
    const len = (await r4.arrayBuffer()).byteLength;
    console.log(`        content-type=${ct}  size=${len}B  cache=${r4.headers.get('x-cache')}`);
    console.log(`        CORS: ${r4.headers.get('access-control-allow-origin')}`);
  }
} else {
  console.log('  SKIP 23. no key supplied (usage: node test.mjs <key>)');
}

// Missing env vars must produce a clear, named error.
const r5 = await onRequest({
  request: new Request(BASE + '/x.png'),
  params: {},
  env: { S3_BUCKET: 'b' },
  waitUntil: () => {},
});
pass = show('24. Missing env vars -> clear error', r5, 500) && pass;
if (r5.status === 500) {
  console.log(`        ${(await r5.text()).split('\n')[0]}`);
}

// The platform routes "/" to functions/index.ts only; keep that file wired up.
const rootEntry = await import('./functions/index.ts');
const sameHandler = rootEntry.onRequest === onRequest;
console.log(`  ${sameHandler ? 'PASS' : 'FAIL'}  25. functions/index.ts points at the same handler`);
pass = sameHandler && pass;

// The hosts are hidden from /health but listed on the landing page, which needs
// the token — that split is what keeps a typo checkable without leaking the list.
const hosts = 'blog.example.com, localhost:5173';
const pageWithHosts = await guardCall('/?token=obj-secret', null, { whitelist: hosts });
const pageWithHostsText = await pageWithHosts.text();
pass =
  show('26. landing page lists the allowlist after login', pageWithHosts, 200) &&
  pageWithHostsText.includes('blog.example.com') &&
  pageWithHostsText.includes('localhost:5173') &&
  pageWithHostsText.includes('hotlink: on (2 hosts)') &&
  pass;

const gateHidesHosts = await guardCall('/', null, { whitelist: hosts });
const gateHidesHostsText = await gateHidesHosts.text();
pass =
  show('27. token prompt does not reveal the allowlist', gateHidesHosts, 401) &&
  !gateHidesHostsText.includes('blog.example.com') &&
  !gateHidesHostsText.includes('hotlink:') &&
  pass;

console.log();
console.log(pass ? 'All passed' : 'Some assertions failed');
process.exit(pass ? 0 : 1);
