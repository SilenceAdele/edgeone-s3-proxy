# edgeone-s3-proxy

S3 reverse proxy — **EdgeOne Pages Edge Function** edition.

Lets a browser load objects from an S3-compatible store that rejects anonymous access and gates requests by User-Agent. Typical use case is an **image host**:

```markdown
![image](https://img.example.com/2026/10/abcd1234ef56.png)
```

---

## Background: a counter-intuitive gateway rule

The target store speaks the S3 protocol, but it **disallows anonymous access** and gates requests by **User-Agent** — an AccessKey is bound to an "application", and the request's User-Agent must match that application name.

Measured rules (each combination tested 5 times, behaviour is stable):

| Auth mechanism | User-Agent requirement |
|---|---|
| `Authorization` header signing (normal SDK / rclone calls) | Must **contain** the app name, **case-insensitive** |
| Presigned URL (query-string auth) | Must **start with** the app name, **case-sensitive** |

Measured matrix (application name `S3Drive`):

| User-Agent | Header auth | Presigned URL |
|---|---|---|
| `S3Drive` | ✅ 200 | ✅ 200 |
| `S3Drive Foo` | ✅ 200 | ✅ 200 |
| `S3drive` | ✅ 200 | ❌ 401 |
| `Foo S3Drive` | ✅ 200 | ❌ 401 |
| `curl/8.7.1` | ❌ 401 | ❌ 401 |
| `Mozilla/5.0` | ❌ 401 | ❌ 401 |
| `random-app` | ❌ 401 | ❌ 401 |

**Consequence:** browsers always send `Mozilla/5.0...`, so every direct link — clean URL or presigned — returns 401. Image hosting, `<img>` embeds and share links are all impossible.

**Fix:** put a middle layer in front that accepts the browser request, rewrites the User-Agent, attaches an SigV4 signature, then proxies upstream. That is this function.

## How it works

```
Browser (Mozilla/5.0)
   ↓  GET https://img.example.com/2026/10/xxx.png
EdgeOne Edge Function
   ↓  User-Agent: S3Drive edgeone-s3-proxy/1.0
   ↓  Authorization: AWS4-HMAC-SHA256 ...
S3 endpoint (Path-Style)
   ↓  GET https://<S3_ENDPOINT>/<S3_BUCKET>/2026/10/xxx.png
```

- **SigV4 signing** implemented with Web Crypto (`crypto.subtle`)
- **Signs exactly** `host;x-amz-content-sha256;x-amz-date`; `User-Agent` is set as an **unsigned** header
- **Never sets the `Host` header** — the platform derives it from the URL; Host appears only in the canonical headers used for signing
- **Three cache layers**: the EdgeOne CDN rule (`caches` in `edgeone.json`), EdgeOne's upstream cache (`eo.cacheEverything`), and the function-level `caches.default`. Default TTL is 7 days with `stale-while-revalidate=86400` so reloads feel instant.
- **CORS open** (`access-control-allow-origin: *`) so an allowed page can also draw
  the bytes on a canvas; what decides who may embed is the Referer check, not CORS
- **Extension allowlist**, so the bucket is not exposed as a general file server
- **Landing page gate**: `/` requires `PROXY_TOKEN`, and that token also unlocks direct object opens
- **Object access control**: optional `IMG_REFERER_WHITELIST` serves only listed hosts; other sites get `403`, direct opens need `PROXY_TOKEN`

## Deployment

1. Create a project on [EdgeOne Pages](https://console.cloud.tencent.com/edgeone/pages) and upload this repository
2. **Project → Settings → Environment Variables** — configure the table below, including `PROXY_TOKEN` and `IMG_REFERER_WHITELIST`
3. Point your domain at it (`img.example.com`)
4. `GET /health` should answer `pages: protected`, the intended `hotlink:` list and `direct: token`; then open `/` and enter the token

### Environment variables

All credentials are read **from environment variables only**. No secret is hardcoded anywhere.

| Variable | Required | Notes |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | ✅ | Set type to **Secret** |
| `AWS_SECRET_ACCESS_KEY` | ✅ | Set type to **Secret** |
| `S3_BUCKET` | ✅ | Bucket name |
| `S3_ENDPOINT` | ✅ | Hostname only, **no** `https://` |
| `S3_REGION` | no | Default `cn-north-1` |
| `UA_PREFIX` | no | Default `S3Drive`; change it if the key is bound to a different application |
| `ALLOWED_EXT` | no | Regex; defaults to images and other static files |
| `CACHE_TTL` | no | Seconds to cache an object. Default `604800` (7 days). Lower it if you overwrite keys in place. |
| `BLOB_CACHE` | no | `on` (default) or `off`. Enables the Pages Blob read-through cache. |
| `BLOB_STORE` | no | Pages Blob namespace name. Default `s3-cache`. |
| `BLOB_LIMIT_BYTES` | no | Eviction ceiling. Default `838860800` (800 MB) — deliberately below the 1 GB free-tier cap. |
| `BLOB_MAX_OBJECT_BYTES` | no | Objects larger than this stream through uncached. Default `5242880` (5 MB). |
| `BLOB_MAX_ENTRIES` | no | Hard cap on cached objects. Default `2000`. |
| `PROXY_TOKEN` | ✅ | Token protecting the landing page at `/`, and the fallback for object requests without a `Referer` when the whitelist is set. Empty = `/` answers `503` (fail closed). Generate with `openssl rand -hex 24`. |
| `IMG_REFERER_WHITELIST` | no | Comma-separated Referer hostnames allowed to load objects; other hosts get `403`, and direct opens need `PROXY_TOKEN`. Empty = every request is served. See [Object access control](#object-access-control). |

If anything is missing the function returns **500 and names the missing variables**, so you do not have to guess.

### Landing page gate

`/` is the documentation page. It lives in `functions/_shared/pages.ts` rather
than `public/`, because EdgeOne serves static files before functions and a static
`index.html` could never be token-gated. `functions/index.ts` re-exports the
handler because EdgeOne maps only `index.ts` to the root path; a catch-all does
not cover `/`.

- Without `PROXY_TOKEN` the page answers `503` with a setup notice instead of
  rendering, so a deployment cannot expose it by accident.
- With the token set, an unknown visitor gets `401` and a token prompt. A
  successful login (`?token=`, the `x-proxy-token` header, or the 12-hour
  `HttpOnly` cookie `proxy_access` holding `sha256(token)`) renders the page.
- `/health` stays public: it returns `pages: protected` or
  `pages: disabled (PROXY_TOKEN is not set)` as a deployment sentinel.
- **The token is shared with object access**: the same login cookie also
  authorises direct image opens, so logging in once at `/` covers both. See
  [Object access control](#object-access-control).

### Object access control

Set `IMG_REFERER_WHITELIST` and object URLs stop being open to the whole
internet. The check runs before Blob and S3, so a rejected request costs nothing
upstream:

```
IMG_REFERER_WHITELIST=blog.example.com,localhost:5173,127.0.0.1:5173
```

| Request | Result |
|---|---|
| `Referer` host is in the list | served — the blog, and nothing else, can embed |
| `Referer` host is anything else | `403 Hotlinking is not allowed`, even with a token |
| No `Referer` (address bar, `curl`, RSS reader) | needs `PROXY_TOKEN`; otherwise `401 Token required` |
| Malformed `Referer` | treated as a direct open, so it needs the token too |
| `IMG_REFERER_WHITELIST` empty | feature off — every request is served |

A direct open accepts the token three ways, all the same `PROXY_TOKEN`:

```bash
curl "https://img.example.com/2026/10/a.jpg?token=$PROXY_TOKEN"   # query
curl -H "x-proxy-token: $PROXY_TOKEN" https://img.example.com/...  # header
```

The third is the `proxy_access` cookie set when you log into `/`, so in a
browser it is enough to open `/` and enter the token once — image links then
work for 12 hours without touching the URL.

Pick entries by asking who actually renders your images:

| Entry | Who sends it |
|---|---|
| `blog.example.com` | The site that embeds the images — every `<img>` on a page sends this as its `Referer` |
| `localhost:5173` | A local dev server opened as `http://localhost:5173/` |
| `127.0.0.1:5173` | The same dev server opened as `http://127.0.0.1:5173/`; the browser treats it as a different host |

Only list hosts that really serve pages. A bare apex domain and its `www.` are
different hosts and both need an entry if both are live; a service that merely
sits behind the blog (an API, a comment backend) does not, because the `Referer`
of an embedded widget is still the blog's host.

- **Hostnames only**, optionally with a port (`localhost:5173`). A pasted
  `https://` prefix or trailing path is stripped, so both forms work.
- **Matched exactly.** No wildcards and no subdomain matching, and the port is
  part of the host.
- **Empty means disabled.** A deployment without the variable keeps serving
  every request, so it cannot break the blog by accident.
- **Fails closed.** With a whitelist set but no `PROXY_TOKEN`, direct opens are
  `401`; there is no implicit bypass.
- **`/health` reports the mode**: `hotlink: <list>` or `hotlink: off`, plus
  `direct: token|closed|open`, so you can confirm the deployment at a glance.
- **Not authentication for the allowed host.** `Referer` is client-supplied, so
  `curl -e https://blog.example.com/ ...` still gets through. This stops other
  sites embedding your images, not someone who read this README.

## Blob read-through cache and the 1 GB ceiling

EdgeOne **does not CDN-cache edge function responses**. Measured: static assets
return `EO-Cache-Status: Cache Hit`, while function routes return no such header
and the function runs on every request. The `caches` rules in `edgeone.json`
only cover static files.

So the proxy keeps a persistent copy in **[Pages Blob](https://pages.edgeone.ai/document/blob-storage)**:

```
request -> function -> Pages Blob
                         |- hit   -> return immediately (no S3 call)
                         `- miss  -> fetch S3 -> write to Blob -> return
```

### Why an index is needed

The Blob SDK never reports object size — `list()` returns only `key` and
`etag`, and `getMetadata()` has no size field. There is no way to ask
"how much am I using?", so the proxy maintains its own manifest:

```
obj/<s3-key>   -> the bytes
__index__      -> {"total": 12345, "entries": {"obj/a.png": {"size": 952106, "at": 1729...}}}
```

### Eviction policy

The free tier is **1 GB of account-level storage**. On each write the proxy
recomputes the total and evicts **FIFO** (oldest write first) until it is back
under budget.

- **Ceiling is 800 MB, not 1 GB.** Concurrent function instances can lose index
  updates — the SDK exposes no atomic compare-and-swap (`onlyIfNew` is
  documented as *not supported*, an existing key is silently overwritten). The
  slack absorbs that drift.
- **FIFO, not LRU.** Tracking recency would mean a write on every read, which
  is rate-limited (`RateLimitedError`) and racy. Objects are content-addressed
  by default, so fresh images are the ones worth keeping.
- **Objects over 5 MB are never buffered** — they stream straight through and
  are never written to Blob.
- Any Blob failure degrades to a plain proxy fetch. The cache is an
  optimisation, never a dependency.

`test-blob.mjs` covers the eviction maths with exact-value assertions against a
mock store.

### Response headers

| `x-cache` | Meaning |
|---|---|
| `HIT-BLOB` | Served from Pages Blob, no S3 call |
| `MISS-WRITTEN` | Fetched from S3 and written to Blob |
| `MISS-WRITE-FAILED` | Fetched from S3, Blob write failed (check quota) |
| `MISS-TOO-BIG` | Over `BLOB_MAX_OBJECT_BYTES`, streamed uncached |
| `MISS` | Cache unavailable (disabled, or SDK failed to load) |

### Caveat

EdgeOne's own docs note that Blob *"is not recommended for use as a public
network image hosting service or CDN."* This design keeps S3 as the source of
truth and Blob strictly as a cache behind the function, but if you push many
gigabytes through it, watch the console's usage page.

## Local verification

You can verify the signing logic without deploying:

```bash
# Credentials are read from ~/.config/imgup.conf (local file, never committed)
node test.mjs <an-object-key-that-exists-in-the-bucket>

# Blob cache eviction maths against a mock store (no EdgeOne needed)
node test-blob.mjs
```

Expected output:

```
PASS  1. Health check /health                          200  (expected 200)
PASS  2. No extension / disallowed type                403  (expected 403)
PASS  3. Valid signature, object missing               404  (expected 404)
PASS  4. " / " without PROXY_TOKEN -> 503              503  (expected 503)
PASS  5. " / " asks for the token                      401  (expected 401)
PASS  6. wrong token refused, never echoed             401  (expected 401)
PASS  7. right token renders the landing page          200  (expected 200)
PASS  8. the cookie opens the page                     200  (expected 200)
PASS  9. health stays public and reports the gate      200  (expected 200)
PASS 10. whitelist parsing (scheme/case/path/port)
PASS 11. refererDecision 8 cases
PASS 12. other sites blocked before S3 lookup          403  (expected 403)
PASS 13. whitelisted Referer reaches upstream          404  (expected 404)
PASS 14. direct open without token -> 401              401  (expected 401)
PASS 15. wrong token refused, never echoed             401  (expected 401)
PASS 16. direct open with the token reaches upstream   404  (expected 404)
PASS 17. token cookie also opens direct access         404  (expected 404)
PASS 18. other sites stay blocked even with a token    403  (expected 403)
PASS 19. empty whitelist disables the check            404  (expected 404)
PASS 20. direct open fails closed without PROXY_TOKEN  401  (expected 401)
PASS 21. health echoes the active whitelist            200  (expected 200)
PASS 22. health reports hotlink: off                   200  (expected 200)
SKIP 23. no key supplied (usage: node test.mjs <key>)
PASS 24. Missing env vars -> clear error               500  (expected 500)
PASS 25. functions/index.ts points at the same handler
All passed
```

Tests 13, 16, 17 and 19 answer `404` rather than `200` because they request a key
that does not exist: reaching upstream is the point, which proves the guard let
them through.

The test **calls `onRequest()` directly**, exercising the real code path, rather than re-implementing the signature separately — that avoids the two drifting apart.

## Security

- **Never** commit AccessKeys. `.env.example` in this repo lists variable names only, with no values.
- A local `.env` used for debugging is excluded by `.gitignore`.
- With no `IMG_REFERER_WHITELIST`, every object that passes the extension
  allowlist is readable by anyone who has the URL. Set the allowlist to close
  that off. Independently, to expose only one directory, add a prefix check in
  `handle()`:

  ```ts
  if (!key.startsWith('public/')) return text('Not found', 404);
  ```

- Prefer creating a **read-only AccessKey** just for this proxy instead of reusing a full-control key.
- `PROXY_TOKEN` gates the documentation page and direct object opens. It is
  **not** required by the blog: whitelisted hosts load images with no token,
  because `<img>` sends a `Referer` but cannot send headers. Rotating the token
  invalidates existing `proxy_access` cookies and any `?token=` links.
- `IMG_REFERER_WHITELIST` trusts a client-supplied header. `curl -e
  https://blog.example.com/ ...` still gets through, so treat it as anti-hotlink,
  not access control. To protect the content itself, keep the bucket private and
  rotate the AccessKey instead.
- A `?token=` URL is a bearer link: anyone who sees it can use it until the token
  is rotated. Prefer the login cookie for browsing, and keep token URLs out of
  public places.

## Known upstream issues (for troubleshooting)

Measured against the S3 gateway in question:

1. **UA gating** makes every browser client fail to reach objects (the subject of this repo)
2. **`put_object_acl` fails silently** — returns 200 but the ACL is unchanged, and the `x-amz-acl` request header is ignored, violating S3 semantics
3. **`get_bucket_policy` returns the wrong type** — a `ListBucketResult` instead of a policy document (the API is not really implemented)
4. **ETag is a UUID**, not the standard MD5

So **anything relying on ACLs or Bucket Policy for access control does not work on this service**, which is why this proxy does its own access control at the edge.

## License

MIT
