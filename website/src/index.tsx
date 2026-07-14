import { Hono } from 'hono'
import {
  duelBefore,
  faviconPngB64,
  installSh,
  llmsTxt,
  ogPngB64,
  skillMd,
  touchIconPngB64,
} from './content.gen'

const app = new Hono()

// CSP hashes for the two inline blocks (computed once at isolate start).
// No 'unsafe-inline': only these exact <style>/<script> bodies may run.
const cspHash = async (s: string) =>
  'sha256-' +
  btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
    )
  )

app.use('*', async (c, next) => {
  await next()
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  if ((c.res.headers.get('content-type') ?? '').includes('text/html')) {
    c.header(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        `style-src '${await cspHash(css)}'`,
        `script-src '${await cspHash(js)}'`,
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; ')
    )
  } else {
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  }
})

const TEXT_CACHE = { 'Cache-Control': 'public, max-age=300' }
app.get('/install', (c) => c.text(installSh, 200, TEXT_CACHE))
app.get('/llms.txt', (c) => c.text(llmsTxt, 200, TEXT_CACHE))
app.get('/skill.md', (c) => c.text(skillMd, 200, TEXT_CACHE))
const PNG_HEADERS = { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }
const png = (b64: string) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
app.get('/og.png', (c) => c.body(png(ogPngB64), 200, PNG_HEADERS))
app.get('/favicon.png', (c) => c.body(png(faviconPngB64), 200, PNG_HEADERS))
app.get('/apple-touch-icon.png', (c) => c.body(png(touchIconPngB64), 200, PNG_HEADERS))

const css = `
:root{--bg:#fff7ec;--card:#fffdf9;--ink:#46372d;--soft:#a08d7c;--line:#f3e2cd;
--acc:#ff5c1a;--acc-soft:#ffe8d6;--shadow:#ffdcc0;--mint:#5bbd94;--mint-soft:#e0f5eb;
--sky:#5aa7e8;--sky-soft:#e3f0fc;
--round:ui-rounded,'Hiragino Maru Gothic ProN',system-ui,sans-serif;
--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--round);line-height:1.65}
a{color:inherit;text-decoration:none}
code,pre{font-family:var(--mono)}
::selection{background:var(--acc-soft);color:#c2410c}
.top{display:flex;align-items:center;justify-content:space-between;max-width:1080px;
margin:0 auto;padding:24px 36px}
.logo{font-size:20px;font-weight:800;display:flex;align-items:center;gap:8px}
.logo b{color:var(--acc)}
.top .star{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;border-radius:999px;
background:var(--acc);color:#fff;font-size:14px;font-weight:800;border:none;
box-shadow:0 4px 0 #d94a10;transition:.15s}
.top .star:hover{transform:translateY(2px);box-shadow:0 1px 0 #d94a10}
.top .star svg{width:16px;height:16px;fill:#ffd9a8}
.intro{max-width:1080px;margin:0 auto;padding:70px 36px 60px;display:grid;
grid-template-columns:minmax(0,1fr) 340px;gap:48px;align-items:center}
.hero-art{display:flex;flex-direction:column;align-items:center;gap:28px}
.mascot{line-height:0;
animation:float 4s ease-in-out infinite;filter:drop-shadow(0 10px 0 var(--shadow));user-select:none}
@keyframes float{0%,100%{transform:translateY(0) rotate(-10deg)}50%{transform:translateY(-12px) rotate(-2deg)}}
.term{width:100%;background:var(--card);border:2px solid var(--line);border-radius:16px;
box-shadow:0 6px 0 var(--shadow);overflow:hidden}
.term .bar{display:flex;gap:6px;padding:10px 14px;border-bottom:2px solid var(--line);background:#fff4e8}
.term .dot{width:10px;height:10px;border-radius:50%;background:var(--shadow)}
.term .dot:first-child{background:var(--acc)}
.term pre{margin:0;padding:14px 16px;font-size:11px;line-height:1.65;overflow-x:auto}
.term .p{color:var(--acc);font-weight:700}
.term .c,.pane .c{color:var(--soft)}
h1{font-size:clamp(34px,6.6vw,64px);line-height:1.08;letter-spacing:-.03em;font-weight:800;margin:0 0 22px;max-width:640px}
.mark{background:var(--acc);color:#fff;padding:.02em .3em;border-radius:14px;display:inline-block;transform:rotate(-2deg)}
.strike{text-decoration:line-through;text-decoration-thickness:4px;text-decoration-color:var(--acc);color:var(--soft)}
.sub{font-size:16.5px;max-width:540px;color:#6b5a4c;margin:0 0 32px}
.scope{font-size:13px;color:var(--soft);margin:-14px 0 22px}
.steps{display:flex;flex-direction:column;gap:12px;max-width:660px}
.step{display:flex;align-items:center;gap:14px;background:var(--card);border:2px solid var(--line);
border-radius:16px;padding:12px 16px;box-shadow:0 5px 0 var(--shadow)}
.step .n{flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;
width:30px;height:30px;border-radius:999px;background:var(--acc);color:#fff;
font-weight:800;font-size:14px;font-family:var(--mono)}
.step .what{flex-shrink:0;font-size:12px;font-weight:800;color:var(--soft);width:88px;
letter-spacing:.06em;text-transform:uppercase}
.step code{font-size:13px;white-space:normal;overflow-wrap:anywhere;flex:1;color:var(--ink)}
.step button{flex-shrink:0;border:none;border-radius:999px;padding:9px 16px;font-size:12.5px;
font-weight:700;font-family:var(--round);background:var(--acc);color:#fff;cursor:pointer;
box-shadow:0 3px 0 #d94a10;transition:.15s}
.step button:hover{transform:translateY(2px);box-shadow:0 1px 0 #d94a10}
section{max-width:1080px;margin:0 auto;padding:0 36px 92px}
h2{font-size:clamp(22px,3.4vw,30px);letter-spacing:-.02em;margin:0 0 26px;font-weight:800}
.duel{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.duel .pane{padding:20px 22px;background:var(--card);min-width:0;border-radius:20px;
border:2px solid var(--line);box-shadow:0 6px 0 var(--shadow)}
.duel .pane.bad{background:#fdf3ea;border-style:dashed;box-shadow:none;opacity:.85}
.duel .tag{display:inline-block;font-size:11.5px;font-weight:700;letter-spacing:.06em;
text-transform:uppercase;margin-bottom:14px;padding:4px 12px;border-radius:999px}
.duel .bad .tag{background:#f6e3d3;color:#a08d7c}
.duel .pane:not(.bad) .tag{background:var(--mint-soft);color:var(--mint)}
.duel pre{margin:0;font-size:12.5px;line-height:1.55;overflow-x:auto;white-space:pre}
.duel .bad pre{color:#a08d7c}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.grid article{padding:24px 22px;background:var(--card);border-radius:20px;border:2px solid var(--line);
box-shadow:0 6px 0 var(--shadow);transition:.15s}
.grid article:hover{transform:translateY(-4px)}
.num{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;
border-radius:999px;font-size:13px;font-weight:800;font-family:var(--mono)}
.grid article:nth-child(3n+1) .num{background:var(--acc-soft);color:var(--acc)}
.grid article:nth-child(3n+2) .num{background:var(--mint-soft);color:var(--mint)}
.grid article:nth-child(3n) .num{background:var(--sky-soft);color:var(--sky)}
.grid h3{font-size:17px;margin:12px 0 8px;font-family:var(--mono);font-weight:700}
.grid p{margin:0 0 14px;font-size:13.5px;color:#6b5a4c}
.grid pre{margin:0;font-size:11.5px;overflow-x:auto;background:#fff4e8;
border-radius:12px;padding:12px 14px;line-height:1.6}
.install ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}
.install li{display:flex;align-items:center;gap:20px;padding:16px 22px;background:var(--card);
border:2px solid var(--line);border-radius:16px}
.install .t{width:110px;flex-shrink:0;font-size:11.5px;font-weight:800;color:var(--soft);
letter-spacing:.08em;text-transform:uppercase}
.install code{font-size:13.5px;overflow-x:auto;white-space:nowrap}
.install code::before{content:'$ ';color:var(--acc);font-weight:700}
.bench .rows{display:flex;flex-direction:column;gap:12px}
.bench .brow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 20px;
align-items:center;background:var(--card);border:2px solid var(--line);border-radius:16px;
padding:14px 20px;box-shadow:0 5px 0 var(--shadow)}
.bench .desc{font-size:14px}
.bench .nums{font-family:var(--mono);font-size:12.5px;color:var(--soft);white-space:nowrap;grid-column:1 / -1}
.bench .nums b{color:var(--ink);font-weight:700}
.bench .delta{font-family:var(--mono);font-size:13px;font-weight:800;color:var(--acc);
white-space:nowrap;background:var(--acc-soft);border-radius:999px;padding:6px 14px}
.bench .note{font-size:12.5px;color:var(--soft);margin-top:14px}
.bench .note a{text-decoration:underline;text-underline-offset:3px}
.bench .note a:hover{color:var(--acc)}
@media(max-width:760px){.bench .brow{grid-template-columns:1fr}.bench .nums{text-align:left}}
.vs .vrow{display:grid;grid-template-columns:minmax(0,1fr) 70px 70px 70px;gap:10px;
align-items:center;padding:10px 18px;background:var(--card);border:2px solid var(--line);border-radius:14px}
.vs .vrow.head{background:transparent;border:none;font-size:11px;font-weight:800;color:var(--soft);
text-transform:uppercase;letter-spacing:.06em;padding:2px 18px}
.vs .vrow span{font-size:13.5px}
.vs .vrow .m{text-align:center;font-family:var(--mono);font-weight:800}
.vs .ok{color:var(--mint)} .vs .no{color:#d9a08d} .vs .half{color:var(--soft)}
.vs .rows{display:flex;flex-direction:column;gap:8px}
.agents .cols{display:grid;grid-template-columns:minmax(0,1fr) 500px;gap:56px;align-items:center}
.agents p{font-size:15px;color:#6b5a4c;margin:0}
.agents .steps{max-width:none}
.bottom{max-width:1080px;margin:0 auto;padding:10px 36px 56px;display:flex;align-items:center;
justify-content:space-between;gap:20px;flex-wrap:wrap;font-size:13px;color:var(--soft)}
.bottom a{text-decoration:underline;text-underline-offset:3px}
.bottom a:hover{color:var(--acc)}
@media(max-width:960px){
.intro{grid-template-columns:1fr;gap:24px}
.hero-art{flex-direction:row;justify-content:center}
.mascot svg{width:90px;height:auto}
.term{max-width:420px}
.agents .cols{grid-template-columns:1fr;gap:24px}
}
@media(max-width:760px){
.duel{grid-template-columns:1fr}
.grid{grid-template-columns:1fr}
.top,.intro,section,.bottom{padding-left:20px;padding-right:20px}
.step{flex-wrap:wrap}
.step code{white-space:normal;word-break:break-all}
.term{display:none}
}`

const js = `
document.querySelectorAll('[data-copy]').forEach(function(btn){
  btn.addEventListener('click',function(){
    navigator.clipboard.writeText(btn.dataset.copy).then(function(){
      var t=btn.textContent
      btn.textContent='copied!'
      setTimeout(function(){btn.textContent=t},1200)
    })
  })
})`

const INSTALL_CMD = 'curl -fsSL https://ax.yusuke.run/install | sh'
const AGENT_PROMPT =
  'ax is installed. Run `ax agent-context` to learn it — use it instead of throwaway scripts.'

const Axe = ({ size }: { size: number }) => (
  <svg
    width={size}
    height={Math.round((size * 130) / 120)}
    viewBox='0 0 120 130'
    aria-hidden='true'
  >
    <g transform='rotate(22 60 65)'>
      <rect
        x='58'
        y='34'
        width='15'
        height='88'
        rx='8'
        fill='#fff3e0'
        stroke='#46372d'
        stroke-width='4.5'
        stroke-linejoin='round'
      />
      <path
        d='M76 28 L38 23 C26 21 14 13 12 14 C5 36 5 56 12 78 C14 79 26 70 38 66 L76 50 Z'
        fill='#ff5c1a'
        stroke='#46372d'
        stroke-width='4.5'
        stroke-linejoin='round'
      />
      <path
        d='M17 26 C12 42 12 52 17 66'
        stroke='#fff'
        opacity='.4'
        stroke-width='5.5'
        fill='none'
        stroke-linecap='round'
      />
    </g>
  </svg>
)

const Page = () => (
  <html lang='en'>
    <head>
      <meta charset='utf-8' />
      <meta name='viewport' content='width=device-width, initial-scale=1' />
      <title>ax — the AI-era curl</title>
      <meta
        name='description'
        content='Fetch, discover, extract — one command. The web tool coding agents reach for instead of curl + throwaway parsing scripts.'
      />
      <meta property='og:type' content='website' />
      <meta property='og:url' content='https://ax.yusuke.run/' />
      <meta property='og:title' content='ax — the AI-era curl' />
      <meta
        property='og:description'
        content='Fetch, discover, extract — one command. The web tool coding agents reach for instead of curl + throwaway parsing scripts.'
      />
      <meta property='og:image' content='https://ax.yusuke.run/og.png' />
      <meta property='og:image:width' content='1200' />
      <meta property='og:image:height' content='630' />
      <meta name='twitter:card' content='summary_large_image' />
      <meta name='twitter:title' content='ax — the AI-era curl' />
      <meta
        name='twitter:description'
        content='Fetch, discover, extract — one command for coding agents.'
      />
      <meta name='twitter:image' content='https://ax.yusuke.run/og.png' />
      <link
        rel='icon'
        href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 130'><g transform='rotate(22 60 65)'><rect x='58' y='34' width='15' height='88' rx='8' fill='%23fff3e0' stroke='%2346372d' stroke-width='4.5'/><path d='M76 28 L38 23 C26 21 14 13 12 14 C5 36 5 56 12 78 C14 79 26 70 38 66 L76 50 Z' fill='%23ff5c1a' stroke='%2346372d' stroke-width='4.5' stroke-linejoin='round'/></g></svg>"
      />
      {/* Safari ignores SVG favicons — PNG fallback + home-screen icon. */}
      <link rel='icon' type='image/png' sizes='64x64' href='/favicon.png' />
      <link rel='apple-touch-icon' href='/apple-touch-icon.png' />
      <style dangerouslySetInnerHTML={{ __html: css }} />
    </head>
    <body>
      <header class='top'>
        <div class='logo'>
          <Axe size={22} /> <b>ax</b>
        </div>
        <a class='star' href='https://github.com/yusukebe/ax'>
          <svg viewBox='0 0 16 16' aria-hidden='true'>
            <path d='M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z' />
          </svg>
          Star on GitHub
        </a>
      </header>

      <div class='intro'>
        <div>
          <h1>
            The AI-era <span class='strike'>curl</span>
            <br />
            <span class='mark'>ax</span> — fetch, discover,
            <br />
            extract. One command.
          </h1>
          <p class='sub'>
            Local HTTP and HTML I/O for coding agents. One command instead of curl + throwaway
            Python — structured, token-cheap, capped by default, never silent.
          </p>
          <div class='steps'>
            <div class='step'>
              <span class='n'>1</span>
              <span class='what'>install</span>
              <code>{INSTALL_CMD}</code>
              <button data-copy={INSTALL_CMD}>copy</button>
            </div>
            <div class='step'>
              <span class='n'>2</span>
              <span class='what'>teach agent</span>
              <code>{AGENT_PROMPT}</code>
              <button data-copy={AGENT_PROMPT}>copy</button>
            </div>
          </div>
        </div>
        <div class='hero-art'>
          <div class='mascot'>
            <Axe size={150} />
          </div>
          <div class='term'>
            <div class='bar'>
              <span class='dot'></span>
              <span class='dot'></span>
              <span class='dot'></span>
            </div>
            <pre
              dangerouslySetInnerHTML={{
                __html: `<span class="c"># what's on this page?</span>
<span class="p">$</span> ax https://shop.example --outline
   80  .prod
<span class="c"># pull it out, structured</span>
<span class="p">$</span> ax https://shop.example '.prod' \\
  --row 'name=h3, price=.price'
name        price
Desk Lamp   $29
Mug         $12
...
<span class="c">ax: note: 80 rows extracted, no empty fields</span>`,
              }}
            />
          </div>
        </div>
      </div>

      <section>
        <h2>Coding agents keep writing this.</h2>
        <div class='duel'>
          <div class='pane bad'>
            <div class='tag'>before — real agent session: 3m 19s · 8.6k tokens</div>
            <pre>{duelBefore}</pre>
          </div>
          <div class='pane'>
            <div class='tag'>after — one ax command</div>
            <pre
              dangerouslySetInnerHTML={{
                __html: `ax https://site.example '.lesson' \\
  --row 'title=a, href=a@href, level=.cefr'

title        href            level
Small talk   /lesson/1.htm   A2
Directions   /lesson/2.htm   A2
...
<span class="c">ax: note: 50 rows extracted, no empty fields</span>`,
              }}
            />
          </div>
        </div>
      </section>

      <section>
        <h2>Fetch. Discover. Extract.</h2>
        <div class='grid'>
          <article>
            <div class='num'>01</div>
            <h3>fetch</h3>
            <p>
              curl-like fetching for agent workflows: every request yields a structured report
              instead of silent failure.
            </p>
            <pre>{`ax https://api.site.example/users
→ { "status": 200, "ok": true,
    "ms": 84, "headers": {...},
    "body": [...] }`}</pre>
          </article>
          <article>
            <div class='num'>02</div>
            <h3>discover</h3>
            <p>Understand an unknown page without dumping raw HTML into context.</p>
            <pre>{`ax https://site.example --outline
   50  div.lesson
ax https://site.example --locate 'text'
ax https://site.example '.card' --count`}</pre>
          </article>
          <article>
            <div class='num'>03</div>
            <h3>extract</h3>
            <p>
              CSS selectors → structured rows. Easier for agents to repair than regex when markup
              changes.
            </p>
            <pre>{`ax url '.item' --row 'title=a, href=a@href'
ax url 'table' --table --where 'Stars > 100'
ax url --md --budget 800   # docs as markdown`}</pre>
          </article>
        </div>
      </section>

      <section class='vs'>
        <h2>Versus the usual local fallback.</h2>
        <p class='scope'>
          What agents reach for inside a coding session: python snippets, htmlq-style selector
          tools, and ax.
        </p>
        <div class='rows'>
          <div class='vrow head'>
            <span></span>
            <span class='m'>python</span>
            <span class='m'>htmlq</span>
            <span class='m'>ax</span>
          </div>
          <div class='vrow'>
            <span>fetch with a full report (status / headers / ms)</span>
            <span class='m half'>△</span>
            <span class='m no'>✗</span>
            <span class='m ok'>✓</span>
          </div>
          <div class='vrow'>
            <span>structure discovery (--outline / --locate)</span>
            <span class='m no'>✗</span>
            <span class='m no'>✗</span>
            <span class='m ok'>✓</span>
          </div>
          <div class='vrow'>
            <span>multi-field rows in one call (--row / --table)</span>
            <span class='m half'>△</span>
            <span class='m no'>✗</span>
            <span class='m ok'>✓</span>
          </div>
          <div class='vrow'>
            <span>easier selector repair after markup drift</span>
            <span class='m no'>✗</span>
            <span class='m ok'>✓</span>
            <span class='m ok'>✓</span>
          </div>
          <div class='vrow'>
            <span>page → readable markdown (--md)</span>
            <span class='m no'>✗</span>
            <span class='m no'>✗</span>
            <span class='m ok'>✓</span>
          </div>
          <div class='vrow'>
            <span>token-shaped output (caps, --budget, never-silent notes)</span>
            <span class='m no'>✗</span>
            <span class='m no'>✗</span>
            <span class='m ok'>✓</span>
          </div>
          <div class='vrow'>
            <span>zero code authored per task</span>
            <span class='m no'>✗</span>
            <span class='m ok'>✓</span>
            <span class='m ok'>✓</span>
          </div>
        </div>
        <p class='note' style='font-size:12.5px;color:#a08d7c;margin-top:14px'>
          △ = possible, but the agent writes and debugs the code every time — that authoring cost is
          the point.
        </p>
      </section>

      <section class='bench'>
        <h2>Benchmarked on real agent sessions.</h2>
        <div class='rows'>
          <div class='brow'>
            <span class='desc'>
              Markup drift across two pages — where regex scripts break (Opus 4.8)
            </span>
            <span class='delta'>−67% cost</span>
            <span class='nums'>
              without ax <b>$0.458</b> → with ax <b>$0.150</b>
            </span>
          </div>
          <div class='brow'>
            <span class='desc'>Structured extraction from a 60-item catalog page (Opus 4.8)</span>
            <span class='delta'>−65% cost</span>
            <span class='nums'>
              without ax <b>$0.296</b> / 24s → with ax <b>$0.104</b> / 14s
            </span>
          </div>
          <div class='brow'>
            <span class='desc'>
              Live website, real internet, decoy markup — median of 3 runs (Opus 4.8)
            </span>
            <span class='delta'>−23% cost</span>
            <span class='nums'>
              without ax <b>$0.248</b> → with ax <b>$0.191</b>
            </span>
          </div>
          <div class='brow'>
            <span class='desc'>
              Same drift task, the agent's first-ever use of ax — cost of reading the docs included
            </span>
            <span class='delta'>−58% cost</span>
            <span class='nums'>
              without ax <b>$0.664</b> → with ax <b>$0.282</b>
            </span>
          </div>
        </div>
        <p class='note'>
          Agent already knowing ax (except the last row). Both sides correct in every run. Method,
          prompts, variance notes and the failed runs —{' '}
          <a href='https://github.com/yusukebe/ax/blob/main/bench/RESULTS.md'>in the repo</a>.
        </p>
      </section>

      <section class='agents'>
        <h2>Built for agents, not just humans.</h2>
        <div class='cols'>
          <p>
            <code>ax agent-context</code> prints the full manual, offline. Paste the prompt for one
            session, or install the skill to make it stick.
          </p>
          <div class='steps'>
            <div class='step'>
              <span class='what'>teach agent</span>
              <code>{AGENT_PROMPT}</code>
              <button data-copy={AGENT_PROMPT}>copy</button>
            </div>
            <div class='step'>
              <span class='what'>add skill</span>
              <code>npx skills add yusukebe/ax</code>
              <button data-copy='npx skills add yusukebe/ax'>copy</button>
            </div>
          </div>
        </div>
      </section>

      <section class='install'>
        <h2>Install</h2>
        <ul>
          <li>
            <span class='t'>curl</span>
            <code>curl -fsSL https://ax.yusuke.run/install | sh</code>
          </li>
          <li>
            <span class='t'>homebrew</span>
            <code>brew install yusukebe/tap/ax</code>
          </li>
          <li>
            <span class='t'>nix</span>
            <code>nix run github:yusukebe/ax</code>
          </li>
          <li>
            <span class='t'>source</span>
            <code>
              git clone https://github.com/yusukebe/ax && cd ax && bun install && bun run build
            </code>
          </li>
        </ul>
      </section>

      <footer class='bottom'>
        <div>
          © {new Date().getFullYear()} <a href='https://github.com/yusukebe'>Yusuke Wada</a> — MIT
        </div>
      </footer>

      <script dangerouslySetInnerHTML={{ __html: js }} />
    </body>
  </html>
)

app.get('/', (c) => c.html(<Page />))

export default app
