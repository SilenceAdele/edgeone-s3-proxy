/**
 * HTML served by the proxy function: the landing page at "/", the token prompt
 * that protects it, and the setup notice shown when the token is missing.
 *
 * The page lives here instead of public/ because EdgeOne serves static files
 * before functions, so a static index.html could never be token-gated.
 */

const LANDING = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>edgeone-s3-proxy</title>
  <style>
    body { font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           max-width: 720px; margin: 48px auto; padding: 0 20px; color: #24292f; }
    code { background: #f6f8fa; padding: 2px 6px; border-radius: 4px;
           font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    pre { background: #f6f8fa; padding: 14px 16px; border-radius: 6px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    h1 { font-size: 24px; }
    h2 { font-size: 17px; margin-top: 32px; border-top: 1px solid #d0d7de; padding-top: 20px; }
    .muted { color: #57606a; }
  </style>
</head>
<body>
  <h1>edgeone-s3-proxy</h1>
  <p class="muted">S3 reverse proxy for EdgeOne Pages Edge Functions.</p>

  <p>This endpoint serves objects from an S3-compatible store that rejects anonymous
  access and gates requests by <code>User-Agent</code>. The edge function rewrites the
  User-Agent and attaches an AWS SigV4 signature before proxying upstream.</p>

  <h2>Health check</h2>
  <pre><code>GET /health
-&gt; edgeone-s3-proxy OK</code></pre>

  <h2>Usage</h2>
  <pre><code>GET /&lt;object-key&gt;

# example
GET /2026/10/abcd1234ef56.png</code></pre>
  <p class="muted">Object URLs stay public on purpose: the blog embeds them with
  <code>&lt;img&gt;</code>. Only this page requires a token.</p>

  <h2>Requirements</h2>
  <p>All credentials are read from environment variables. Configure them in the
  EdgeOne Pages console under <em>Project &rarr; Settings &rarr; Environment Variables</em>:</p>
  <pre><code>AWS_ACCESS_KEY_ID      (type: Secret)
AWS_SECRET_ACCESS_KEY  (type: Secret)
S3_BUCKET
S3_ENDPOINT            hostname only, no https://
S3_REGION              optional, default cn-north-1
UA_PREFIX              optional, default S3Drive
PROXY_TOKEN            token for this page (required)</code></pre>

  <h2>Source</h2>
  <p><a href="https://github.com/SilenceAdele/edgeone-s3-proxy">github.com/SilenceAdele/edgeone-s3-proxy</a></p>
</body>
</html>
`;

export const pageFor = (path: string): string | null => (path === '/' ? LANDING : null);

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const esc = (value: string): string => value.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const GATE_STYLE = `
    *{box-sizing:border-box}
    :root{--brand:#409eff;--ink:#2c3e50;--muted:#5b6674}
    body{margin:0;min-height:100vh;display:grid;place-items:center;overflow:hidden;
         background:radial-gradient(60% 60% at 20% 20%,#bfdcff 0,transparent 60%),
                    radial-gradient(55% 55% at 85% 25%,#ded2ff 0,transparent 62%),
                    radial-gradient(60% 60% at 50% 95%,#c9f0dd 0,transparent 60%),#e9f0f8;
         color:var(--ink);font:15px/1.7 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}
    body::before{content:'';position:fixed;inset:-20%;pointer-events:none;opacity:.75;
         background:radial-gradient(35% 35% at 30% 40%,#9dc6ff 0,transparent 70%),
                    radial-gradient(30% 30% at 75% 60%,#e2c8ff 0,transparent 70%);
         filter:blur(46px)}
    form,.card{position:relative;width:min(400px,calc(100vw - 40px));padding:30px 28px 26px;
         background:rgba(255,255,255,.62);border:1px solid rgba(255,255,255,.8);border-radius:16px;
         box-shadow:0 24px 60px rgba(44,62,80,.18);
         -webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%)}
    h1{margin:0 0 6px;font-size:19px}
    p.lead{margin:0 0 20px;color:var(--muted);font-size:13px}
    .error{margin:0 0 16px;padding:8px 12px;border-radius:8px;background:rgba(214,69,69,.1);
           border:1px solid rgba(214,69,69,.25);color:#b03030;font-size:13px}
    .error:empty{display:none}
    label{display:block;margin-bottom:8px;font-size:12px;color:var(--muted);
          letter-spacing:.04em;text-transform:uppercase}
    .field{position:relative}
    input{width:100%;padding:11px 44px 11px 12px;border:1px solid rgba(44,62,80,.18);
          border-radius:10px;background:rgba(255,255,255,.85);color:var(--ink);font:inherit;outline:none}
    input:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(64,158,255,.18)}
    .peek{position:absolute;top:50%;right:6px;transform:translateY(-50%);display:grid;place-items:center;
          width:30px;height:30px;padding:0;border:0;border-radius:8px;background:transparent;
          color:var(--muted);cursor:pointer}
    .peek:hover{background:rgba(64,158,255,.1);color:var(--brand)}
    .peek svg{width:17px;height:17px}
    .peek .eye-off{display:none}
    .peek.shown .eye{display:none}
    .peek.shown .eye-off{display:block}
    button.go{width:100%;margin-top:16px;padding:11px;border:0;border-radius:10px;
          background:var(--brand);color:#fff;font:inherit;font-weight:600;cursor:pointer;
          box-shadow:0 8px 20px rgba(64,158,255,.35)}
    button.go:hover{filter:brightness(1.05)}
    p.meta{margin:14px 0 0;color:var(--muted);font-size:12px;text-align:center}
    .card{text-align:center}
    .card p.lead{margin-bottom:0}
    code{padding:1px 5px;border-radius:5px;background:rgba(44,62,80,.08);
         font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}`;

/** The token prompt shown for "/". */
export function gatePage(action: string, error: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>需要访问令牌</title>
<style>${GATE_STYLE}
</style>
</head>
<body>
<form method="get" action="${esc(action)}">
  <h1>需要访问令牌</h1>
  <p class="lead">输入管理员令牌后查看说明页。</p>
  <div class="error">${error ? esc(error) : ''}</div>
  <label for="token">管理员令牌</label>
  <div class="field">
    <input id="token" name="token" type="password" placeholder="TOKEN" autocomplete="current-password"
           autocapitalize="off" spellcheck="false" autofocus>
    <button type="button" class="peek" id="peek" aria-label="显示令牌" title="显示令牌">
      <svg class="eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
      <svg class="eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>
    </button>
  </div>
  <button type="submit" class="go">进入</button>
</form>
<script>
  var input = document.getElementById('token');
  var peek = document.getElementById('peek');
  peek.addEventListener('click', function () {
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    peek.classList.toggle('shown', show);
    peek.setAttribute('aria-label', show ? '隐藏令牌' : '显示令牌');
    peek.title = show ? '隐藏令牌' : '显示令牌';
    input.focus();
  });
</script>
</body>
</html>`;
}

/**
 * Shown instead of the landing page when PROXY_TOKEN is missing. The page fails
 * closed: without a token it must not render.
 */
export function disabledPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>说明页未启用</title>
<style>${GATE_STYLE}
</style>
</head>
<body>
<div class="card">
  <h1>说明页未启用</h1>
  <p class="lead">
    部署环境没有配置 <code>PROXY_TOKEN</code>，本页默认关闭。<br>
    在 EdgeOne 控制台的「环境变量」里加上它（可用 <code>openssl rand -hex 24</code> 生成），
    重新部署后即可访问。图片地址不受影响。
  </p>
</div>
</body>
</html>`;
}