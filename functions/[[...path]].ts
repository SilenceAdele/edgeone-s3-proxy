/**
 * edgeone-s3-proxy - S3 reverse proxy (EdgeOne Pages Edge Function)
 *
 * Lets a browser load objects from an S3-compatible store that rejects
 * anonymous access and gates requests by User-Agent.
 *
 *   Browser  ->  https://img.example.com/2026/10/abcd1234ef56.png
 *   Function ->  rewrite User-Agent + attach AWS SigV4 signature
 *   S3       ->  https://<S3_ENDPOINT>/<S3_BUCKET>/2026/10/abcd1234ef56.png
 *
 * Caching: EdgeOne does NOT CDN-cache edge function responses (verified: static
 * assets return `EO-Cache-Status: Cache Hit`, function routes return no such
 * header). So a read-through cache is implemented on Pages Blob instead.
 *
 * IMPORTANT: all credentials are read from environment variables only.
 * Nothing sensitive is hardcoded. Configure them in the EdgeOne Pages
 * console under Project -> Settings -> Environment Variables.
 */

// ---------- Defaults (every one can be overridden by env) ----------
const DEFAULT_REGION = 'cn-north-1';
const DEFAULT_UA_PREFIX = 'S3Drive';
const DEFAULT_ALLOWED_EXT =
  '\\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|mp4|webm|pdf|json|txt|md)$';
const DEFAULT_CACHE_TTL = 604800; // 7 days, in seconds

// Blob cache budget. The free Pages Blob tier is 1GB per *account*, and the
// SDK reports no object sizes from list(), so we track sizes ourselves in an
// index and evict FIFO once over budget. The limit is deliberately below 1GB
// to absorb lost index updates under concurrent writes (the SDK exposes no
// atomic compare-and-swap).
const DEFAULT_BLOB_STORE = 's3-cache';
const DEFAULT_BLOB_LIMIT = 800 * 1024 * 1024; // 800 MB
const DEFAULT_BLOB_MAX_OBJECT = 5 * 1024 * 1024; // 5 MB
const DEFAULT_BLOB_MAX_ENTRIES = 2000;
const INDEX_KEY = '__index__';

/** EdgeOne Edge Function context (hand-written to avoid a type dependency). */
interface FnContext {
  request: Request;
  params: Record<string, string | string[]>;
  env: Record<string, string | undefined>;
  waitUntil?: (p: Promise<unknown>) => void;
  eo?: { geo?: unknown; clientIp?: string };
}

// ================= Entry point =================

export const onRequest = async (ctx: FnContext): Promise<Response> => {
  try {
    return await handle(ctx);
  } catch (e) {
    return text(`Proxy error: ${(e as Error).message}`, 502);
  }
};

async function handle(ctx: FnContext): Promise<Response> {
  const { request, env } = ctx;

  // ---- Health check (no credential required, proves the function is live) ----
  const url = new URL(request.url);
  if (url.pathname === '/' || url.pathname === '/health') {
    return text('edgeone-s3-proxy OK\n', 200);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text('Method Not Allowed', 405);
  }

  // ---- Config: everything comes from environment variables ----
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  const bucket = env.S3_BUCKET;
  const endpoint = env.S3_ENDPOINT;
  const region = env.S3_REGION || DEFAULT_REGION;
  const uaPrefix = env.UA_PREFIX || DEFAULT_UA_PREFIX;
  const allowedExt = new RegExp(env.ALLOWED_EXT || DEFAULT_ALLOWED_EXT, 'i');
  // Seconds to cache an object. Object keys are content-addressed (md5-based),
  // so a long TTL is safe. Override with CACHE_TTL if you reuse human-readable keys.
  const cacheTtl = Number(env.CACHE_TTL || DEFAULT_CACHE_TTL);

  const blobCfg = {
    enabled: (env.BLOB_CACHE || 'on').toLowerCase() !== 'off',
    storeName: env.BLOB_STORE || DEFAULT_BLOB_STORE,
    limitBytes: Number(env.BLOB_LIMIT_BYTES || DEFAULT_BLOB_LIMIT),
    maxObjectBytes: Number(env.BLOB_MAX_OBJECT_BYTES || DEFAULT_BLOB_MAX_OBJECT),
    maxEntries: Number(env.BLOB_MAX_ENTRIES || DEFAULT_BLOB_MAX_ENTRIES),
  };

  const missing = (
    [
      ['AWS_ACCESS_KEY_ID', accessKeyId],
      ['AWS_SECRET_ACCESS_KEY', secretAccessKey],
      ['S3_BUCKET', bucket],
      ['S3_ENDPOINT', endpoint],
    ] as Array<[string, string | undefined]>
  )
    .filter(([, v]) => !v || isPlaceholder(v!))
    .map(([k]) => k);

  if (missing.length) {
    return text(
      `Missing environment variables: ${missing.join(', ')}\n\n` +
        `Configure them in EdgeOne Pages console, Project -> Settings -> Environment Variables:\n` +
        `  AWS_ACCESS_KEY_ID      (type: Secret)\n` +
        `  AWS_SECRET_ACCESS_KEY  (type: Secret)\n` +
        `  S3_BUCKET\n` +
        `  S3_ENDPOINT            hostname only, no https://\n` +
        `  S3_REGION              optional, default ${DEFAULT_REGION}\n` +
        `  UA_PREFIX              optional, default ${DEFAULT_UA_PREFIX}\n` +
        `  ALLOWED_EXT            optional, default static/image files\n` +
        `  CACHE_TTL              optional, default ${DEFAULT_CACHE_TTL}\n` +
        `  BLOB_CACHE             optional, on|off, default on\n` +
        `  BLOB_LIMIT_BYTES       optional, default ${DEFAULT_BLOB_LIMIT}\n`,
      500,
    );
  }

  // ---- Resolve object key ----
  const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!key) return text('Missing object key', 400);
  if (key.includes('..')) return text('Bad key', 400);
  if (!allowedExt.test(key)) return text('File type not allowed', 403);

  const host = endpoint!.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const originUrl = `https://${host}/${bucket}/${key}`;
  const path = `/${bucket}/${key}`;

  // ---- 1. Read-through cache: try Pages Blob first ----
  let cacheStatus = 'MISS';
  const store = blobCfg.enabled ? await getStore(blobCfg) : null;
  if (store) {
    const cached = await blobGet(store, key);
    if (cached) {
      return new Response(request.method === 'HEAD' ? null : cached.body, {
        status: 200,
        headers: {
          'content-type': cached.contentType || 'application/octet-stream',
          'content-length': String(cached.body.byteLength),
          'cache-control': `public, max-age=${cacheTtl}, s-maxage=${cacheTtl}, stale-while-revalidate=86400`,
          'access-control-allow-origin': '*',
          'x-cache': 'HIT-BLOB',
        },
      });
    }
  }

  // ---- 2. Fetch upstream with a SigV4-signed request ----
  const headers = await signRequest({
    method: 'GET',
    host,
    path,
    region,
    service: 's3',
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    uaPrefix,
  });

  // EdgeOne's fetch accepts extra `eo` cache hints. Ignored by other runtimes.
  const fetchInit: RequestInit & { eo?: Record<string, unknown> } = {
    method: 'GET',
    headers,
    eo: {
      cacheEverything: true,
      cacheTtl,
      cacheKey: originUrl,
    },
  };
  const originRes = await fetch(originUrl, fetchInit);

  if (!originRes.ok) {
    return text(`S3 upstream ${originRes.status}`, originRes.status);
  }

  const contentType = originRes.headers.get('content-type') || 'application/octet-stream';
  const declared = Number(originRes.headers.get('content-length') || '0');

  // Larger than the cache ceiling: stream straight through, never buffer.
  if (declared > blobCfg.maxObjectBytes) {
    return new Response(request.method === 'HEAD' ? null : originRes.body, {
      status: originRes.status,
      headers: {
        'content-type': contentType,
        'content-length': originRes.headers.get('content-length') || '',
        'cache-control': `public, max-age=${cacheTtl}, s-maxage=${cacheTtl}, stale-while-revalidate=86400`,
        'access-control-allow-origin': '*',
        'x-cache': 'MISS-TOO-BIG',
      },
    });
  }

  const buf = await originRes.arrayBuffer();

  // stale-while-revalidate keeps reloads instant while the cache refreshes.
  // The validator requires SWR/SIE in key=value form.
  const out = new Response(request.method === 'HEAD' ? null : buf.slice(0), {
    status: originRes.status,
    headers: {
      'content-type': contentType,
      'content-length': String(buf.byteLength),
      'cache-control': `public, max-age=${cacheTtl}, s-maxage=${cacheTtl}, stale-while-revalidate=86400`,
      'access-control-allow-origin': '*',
      'x-cache': cacheStatus,
    },
  });

  // ---- 3. Populate the cache in the background; never block the response ----
  if (store && buf.byteLength > 0 && buf.byteLength <= blobCfg.maxObjectBytes) {
    const job = blobPut(store, key, buf, contentType, blobCfg).then((r) => {
      out.headers.set('x-cache', r ? 'MISS-WRITTEN' : 'MISS-WRITE-FAILED');
    });
    if (ctx.waitUntil) ctx.waitUntil(job);
  }

  return out;
}

// ================= Pages Blob read-through cache =================
// EdgeOne does not CDN-cache function responses, so we keep a persistent copy
// in Pages Blob. The SDK's list()/getMetadata() expose no object size, hence
// the parallel __index__ manifest that records size + write time per key.
// Eviction is FIFO (oldest write first): updating an LRU timestamp on every
// read would mean a write per request, which is rate-limited and racy.

interface BlobCfg {
  enabled: boolean;
  storeName: string;
  limitBytes: number;
  maxObjectBytes: number;
  maxEntries: number;
}

interface CacheIndex {
  total: number;
  entries: Record<string, { size: number; at: number }>;
}

let _store: any = null;
let _storeTried = false;

/** Lazy-load the SDK so a missing package degrades instead of breaking the proxy. */
async function getStore(cfg: BlobCfg): Promise<any> {
  if (_storeTried) return _store;
  _storeTried = true;
  try {
    const mod: any = await import('@edgeone/pages-blob');
    _store = mod.getStore(cfg.storeName);
  } catch {
    _store = null;
  }
  return _store;
}

function emptyIndex(): CacheIndex {
  return { total: 0, entries: {} };
}

async function readIndex(store: any): Promise<CacheIndex> {
  try {
    const raw = await store.get(INDEX_KEY, { type: 'text' });
    if (!raw) return emptyIndex();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) return emptyIndex();
    return { total: Number(parsed.total) || 0, entries: parsed.entries };
  } catch {
    return emptyIndex();
  }
}

async function blobGet(
  store: any,
  key: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  try {
    if (!store) return null;
    const body = await store.get(`obj/${key}`, { type: 'arrayBuffer' });
    if (!body) return null;
    let contentType = 'application/octet-stream';
    try {
      const meta = await store.getMetadata(`obj/${key}`);
      contentType = meta?.contentType || contentType;
    } catch {
      /* metadata is best-effort */
    }
    return { body, contentType };
  } catch {
    return null;
  }
}

/** Exported for tests: FIFO eviction keeps the manifest within budget. */
export function evictToBudget(index: CacheIndex, cfg: BlobCfg): string[] {
  const softLimit = Math.floor(cfg.limitBytes * 0.95);
  const removed: string[] = [];
  // Recompute up front: a stale total (lost updates, manual edits) must not
  // make the loop spin or under-evict.
  index.total = Object.values(index.entries).reduce((n, e) => n + (e.size || 0), 0);
  while (
    (index.total > softLimit || Object.keys(index.entries).length > cfg.maxEntries) &&
    Object.keys(index.entries).length > 0
  ) {
    let oldestKey = '';
    let oldestAt = Infinity;
    for (const [k, v] of Object.entries(index.entries)) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    // Decrement INSIDE the loop. Recomputing only after the loop left the
    // while-condition permanently true and drained the whole cache.
    index.total = Math.max(0, index.total - (index.entries[oldestKey].size || 0));
    delete index.entries[oldestKey];
    removed.push(oldestKey);
  }
  return removed;
}

export async function blobPut(
  store: any,
  key: string,
  buf: ArrayBuffer,
  contentType: string,
  cfg: BlobCfg,
): Promise<boolean> {
  try {
    if (!store) return false;

    const blobKey = `obj/${key}`;
    await store.set(blobKey, buf, { cacheControl: 'public, max-age=31536000' });

    const index = await readIndex(store);
    index.entries[blobKey] = { size: buf.byteLength, at: Date.now() };
    // Recompute the total rather than trusting the stored value: concurrent
    // writers can lose index updates, and a recomputed total self-heals.
    index.total = Object.values(index.entries).reduce((n, e) => n + (e.size || 0), 0);

    for (const k of evictToBudget(index, cfg)) {
      try {
        await store.delete(k);
      } catch {
        /* already gone */
      }
    }

    await store.setJSON(INDEX_KEY, index);
    return true;
  } catch {
    return false;
  }
}

// ================= AWS Signature V4 =================
// Signing uses exactly host;x-amz-content-sha256;x-amz-date.
// User-Agent is set as an UNSIGNED header (SigV4 allows unsigned headers).
// This combination is what measurably passes the gateway's checks.

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(data)));
}

async function hmacRaw(key: BufferSource | string, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data)));
}

/** AWS URI encoding: even !'()* must be escaped; path separators '/' are kept. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((seg) =>
      encodeURIComponent(seg)
        .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
        .replace(/%2F/gi, '/'),
    )
    .join('/');
}

async function signRequest(opts: {
  method: string;
  host: string;
  path: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  uaPrefix: string;
}): Promise<Record<string, string>> {
  const { method, host, path, region, service, accessKeyId, secretAccessKey, uaPrefix } = opts;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20261020T120000Z
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await sha256Hex(''); // GET empty body

  const canonicalHeaders =
    [`host:${host}`, `x-amz-content-sha256:${payloadHash}`, `x-amz-date:${amzDate}`].join('\n') +
    '\n';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    method,
    encodePath(path),
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  let key = await hmacRaw(`AWS4${secretAccessKey}`, dateStamp);
  key = await hmacRaw(key, region);
  key = await hmacRaw(key, service);
  key = await hmacRaw(key, 'aws4_request');
  const signature = toHex(await hmacRaw(key, stringToSign));

  return {
    // Do NOT set the Host header: the platform derives it from the URL.
    // Host still appears in canonical headers above and is signed there.
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    // The gateway validates this header; it must match UA_PREFIX.
    'User-Agent': `${uaPrefix} edgeone-s3-proxy/1.0`,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ================= Helpers =================

function isPlaceholder(v: string): boolean {
  return /REPLACE|your-|example|xxx|TODO|CHANGEME/i.test(v);
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
