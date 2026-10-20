# edgeone-s3-proxy

S3 reverse proxy — **EdgeOne Pages Edge Function** edition.

Lets a browser load objects from an S3-compatible store that rejects anonymous access and gates requests by User-Agent. Typical use case is an **image host**:

```markdown
![image](https://img.example.com/2026/10/abcd1234ef56.png)
```

> Cloudflare Workers edition: [`cstcloud-s3-proxy`](https://github.com/SilenceAdele/cstcloud-s3-proxy).

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

- **SigV4 signing** implemented with Web Crypto (`crypto.subtle`, available on both EdgeOne and Cloudflare)
- **Signs exactly** `host;x-amz-content-sha256;x-amz-date`; `User-Agent` is set as an **unsigned** header
- **Never sets the `Host` header** — the platform derives it from the URL; Host appears only in the canonical headers used for signing
- **Edge caching** for one year (`immutable`) via `caches.default`
- **CORS open**, so any page can embed with `<img>`
- **Extension allowlist**, so the bucket is not exposed as a general file server

## Deployment

1. Create a project on [EdgeOne Pages](https://console.cloud.tencent.com/edgeone/pages) and upload this repository
2. **Project → Settings → Environment Variables** — configure the table below
3. Point your domain at it (`img.example.com`)

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

If anything is missing the function returns **500 and names the missing variables**, so you do not have to guess.

## Local verification

You can verify the signing logic without deploying:

```bash
# Credentials are read from ~/.config/imgup.conf (local file, never committed)
node test.mjs <an-object-key-that-exists-in-the-bucket>
```

Expected output:

```
✅ ① Health check /                                   200
✅ ② No extension / disallowed type                    403
✅ ③ Valid signature, object missing                   404
✅ ④ Fetch existing object image-bed/xxx.jpg           200
     content-type=image/jpeg  size=3638867B  CORS: *
✅ ⑤ Missing env vars -> clear error                    500
✅ All passed
```

The test **calls `onRequest()` directly**, exercising the real code path, rather than re-implementing the signature separately — that avoids the two drifting apart.

## Security

- **Never** commit AccessKeys. `.env.example` in this repo lists variable names only, with no values.
- A local `.env` used for debugging is excluded by `.gitignore`.
- The proxy makes **every object that passes the extension allowlist** publicly readable. To expose only one directory, add a prefix check in `handle()`:

  ```ts
  if (!key.startsWith('public/')) return text('Not found', 404);
  ```

- Prefer creating a **read-only AccessKey** just for this proxy instead of reusing a full-control key.

## Known upstream issues (for troubleshooting)

Measured against the S3 gateway in question:

1. **UA gating** makes every browser client fail to reach objects (the subject of this repo)
2. **`put_object_acl` fails silently** — returns 200 but the ACL is unchanged, and the `x-amz-acl` request header is ignored, violating S3 semantics
3. **`get_bucket_policy` returns the wrong type** — a `ListBucketResult` instead of a policy document (the API is not really implemented)
4. **ETag is a UUID**, not the standard MD5

So **anything relying on ACLs or Bucket Policy for access control does not work on this service**, which is why this proxy does its own access control at the edge.

## License

MIT
