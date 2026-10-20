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
 * IMPORTANT: all credentials are read from environment variables only.
 * Nothing sensitive is hardcoded. Configure them in the EdgeOne Pages
 * console under Project -> Settings -> Environment Variables.
 */

// ---------- Defaults (every one can be overridden by env) ----------
const DEFAULT_REGION = 'cn-north-1';
const DEFAULT_UA_PREFIX = 'S3Drive';
const DEFAULT_ALLOWED_EXT =
  '\\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|mp4|webm|pdf|json|txt|md)$';

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
        `  ALLOWED_EXT            optional, default static/image files\n`,
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

  // ---- Serve from cache when possible ----
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set('x-cache', 'HIT');
    return res;
  }

  // ---- Fetch upstream with a SigV4-signed request ----
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

  const originRes = await fetch(originUrl, { method: 'GET', headers });

  if (!originRes.ok) {
    return text(`S3 upstream ${originRes.status}`, originRes.status);
  }

  const out = new Response(request.method === 'HEAD' ? null : originRes.body, {
    status: originRes.status,
    headers: {
      'content-type': originRes.headers.get('content-type') || 'application/octet-stream',
      'content-length': originRes.headers.get('content-length') || '',
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
      'x-cache': 'MISS',
    },
  });

  // Write to cache in the background so the response is not blocked.
  if (ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, out.clone()));
  else await cache.put(cacheKey, out.clone());

  return out;
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

  const payloadHash = await sha256Hex(''); // empty body for GET

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
