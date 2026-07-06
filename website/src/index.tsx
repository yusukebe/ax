import { Hono } from 'hono'
import { duelBefore, installSh, llmsTxt, ogPngB64, skillMd } from './content.gen'

const app = new Hono()

app.get('/install', (c) => c.text(installSh))
app.get('/llms.txt', (c) => c.text(llmsTxt))
app.get('/skill.md', (c) => c.text(skillMd))
app.get('/og.png', (c) => {
  const bytes = Uint8Array.from(atob(ogPngB64), (ch) => ch.charCodeAt(0))
  return c.body(bytes, 200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400',
  })
})

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
.mascot{font-size:140px;line-height:1;
animation:float 4s ease-in-out infinite;filter:drop-shadow(0 10px 0 var(--shadow));user-select:none}
@keyframes float{0%,100%{transform:translateY(0) rotate(-10deg)}50%{transform:translateY(-12px) rotate(-2deg)}}
.term{width:100%;background:var(--card);border:2px solid var(--line);border-radius:16px;
box-shadow:0 6px 0 var(--shadow);overflow:hidden}
.term .bar{display:flex;gap:6px;padding:10px 14px;border-bottom:2px solid var(--line);background:#fff4e8}
.term .dot{width:10px;height:10px;border-radius:50%;background:var(--shadow)}
.term .dot:first-child{background:var(--acc)}
.term pre{margin:0;padding:14px 16px;font-size:11.5px;line-height:1.65;overflow-x:auto}
.term .p{color:var(--acc);font-weight:700}
h1{font-size:clamp(34px,6.6vw,64px);line-height:1.08;letter-spacing:-.03em;font-weight:800;margin:0 0 22px;max-width:640px}
.mark{background:var(--acc);color:#fff;padding:.02em .3em;border-radius:14px;display:inline-block;transform:rotate(-2deg)}
.strike{text-decoration:line-through;text-decoration-thickness:4px;text-decoration-color:var(--acc);color:var(--soft)}
.sub{font-size:16.5px;max-width:540px;color:#6b5a4c;margin:0 0 32px}
.steps{display:flex;flex-direction:column;gap:12px;max-width:660px}
.step{display:flex;align-items:center;gap:14px;background:var(--card);border:2px solid var(--line);
border-radius:16px;padding:12px 16px;box-shadow:0 5px 0 var(--shadow)}
.step .n{flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;
width:30px;height:30px;border-radius:999px;background:var(--acc);color:#fff;
font-weight:800;font-size:14px;font-family:var(--mono)}
.step .what{flex-shrink:0;font-size:12px;font-weight:800;color:var(--soft);width:88px;
letter-spacing:.06em;text-transform:uppercase}
.step code{font-size:13px;overflow-x:auto;white-space:nowrap;flex:1;color:var(--ink)}
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
.agents p{max-width:640px;font-size:15px;color:#6b5a4c}
.agents .files{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
.files a{display:inline-flex;gap:8px;border-radius:999px;padding:11px 18px;font-size:13px;
font-family:var(--mono);background:var(--card);border:2px solid var(--line);
box-shadow:0 4px 0 var(--shadow);transition:.15s}
.files a:hover{transform:translateY(2px);box-shadow:0 1px 0 var(--shadow)}
.files a span{color:var(--acc);font-weight:700}
.bottom{max-width:1080px;margin:0 auto;padding:10px 36px 56px;display:flex;align-items:center;
justify-content:space-between;gap:20px;flex-wrap:wrap;font-size:13px;color:var(--soft)}
.bottom a{text-decoration:underline;text-underline-offset:3px}
.bottom a:hover{color:var(--acc)}
@media(max-width:960px){
.intro{grid-template-columns:1fr;gap:24px}
.hero-art{flex-direction:row;justify-content:center}
.mascot{font-size:80px}
.term{max-width:420px}
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
  'The ax CLI is installed. Run `ax agent-context` to learn it, then use it instead of writing throwaway python/regex scripts.'

const Page = () => (
  <html lang='en'>
    <head>
      <meta charset='utf-8' />
      <meta name='viewport' content='width=device-width, initial-scale=1' />
      <title>ax — a scriptless multitool for AI agents</title>
      <meta
        name='description'
        content='One binary that replaces the throwaway scripts your agent keeps writing. Extract HTML, query JSON/YAML, process text — token-cheap by design.'
      />
      <meta property='og:type' content='website' />
      <meta property='og:url' content='https://ax.yusuke.run/' />
      <meta property='og:title' content='ax — a scriptless multitool for AI agents' />
      <meta
        property='og:description'
        content='One binary that replaces the throwaway scripts your agent keeps writing. Extract HTML, query JSON/YAML, process text — token-cheap by design.'
      />
      <meta property='og:image' content='https://ax.yusuke.run/og.png' />
      <meta property='og:image:width' content='1200' />
      <meta property='og:image:height' content='630' />
      <meta name='twitter:card' content='summary_large_image' />
      <meta name='twitter:title' content='ax — a scriptless multitool for AI agents' />
      <meta
        name='twitter:description'
        content='One binary that replaces the throwaway scripts your agent keeps writing.'
      />
      <meta name='twitter:image' content='https://ax.yusuke.run/og.png' />
      <link
        rel='icon'
        href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🪓</text></svg>"
      />
      <style dangerouslySetInnerHTML={{ __html: css }} />
    </head>
    <body>
      <header class='top'>
        <div class='logo'>
          🪓 <b>ax</b>
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
            One binary.
            <br />
            No more <span class='strike'>throwaway scripts</span>.<br />
            Just <span class='mark'>ax</span>.
          </h1>
          <p class='sub'>
            A scriptless multitool for AI agents. Extract from HTML, query JSON and YAML, process
            text, decode and convert — in one line instead of a python heredoc. Token-cheap output,
            structured errors, capped by default.
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
          <div class='mascot'>🪓</div>
          <div class='term'>
            <div class='bar'>
              <span class='dot'></span>
              <span class='dot'></span>
              <span class='dot'></span>
            </div>
            <pre
              dangerouslySetInnerHTML={{
                __html: `<span class="p">$</span> ax html page.html '.lesson' \\
    --row 'title=a, level=.cefr'
[
  { "title": "Small talk",
    "level": "A2" },
  ...
]
<span class="p">$</span> ax enc jwt "$TOKEN"
{ "payload": { "name": "yusuke" } }`,
              }}
            />
          </div>
        </div>
      </div>

      <section>
        <h2>Agents keep writing this.</h2>
        <div class='duel'>
          <div class='pane bad'>
            <div class='tag'>before — 3m19s, 8.6k tokens</div>
            <pre>{duelBefore}</pre>
          </div>
          <div class='pane'>
            <div class='tag'>after — one line</div>
            <pre>{`ax html page.html '.lesson' \\
  --row 'title=a, href=a@href, level=.cefr'

[
  { "title": "Small talk",
    "href": "/lesson/1.htm",
    "level": "A2" },
  ...
]`}</pre>
          </div>
        </div>
      </section>

      <section>
        <h2>Six commands. JSON is the lingua franca.</h2>
        <div class='grid'>
          <article>
            <div class='num'>01</div>
            <h3>ax html</h3>
            <p>CSS selectors, structured rows, tables, and discovery for unknown pages.</p>
            <pre>{`ax html url '.card' --row 'title=a'
ax html url 'table' --table
ax html url --outline / --locate`}</pre>
          </article>
          <article>
            <div class='num'>02</div>
            <h3>ax json</h3>
            <p>A jq-subset path language plus --where expressions.</p>
            <pre>{`ax json api.json '.items[].name'
ax json api.json '.users[]' \\
  --where 'age > 20'`}</pre>
          </article>
          <article>
            <div class='num'>03</div>
            <h3>ax yaml</h3>
            <p>Same paths, same flags — for compose, CI, k8s configs.</p>
            <pre>{`ax yaml compose.yml \\
  '.services[].image' --raw`}</pre>
          </article>
          <article>
            <div class='num'>04</div>
            <h3>ax text</h3>
            <p>grep, extract, frequency tables — the shell idioms, built in.</p>
            <pre>{`ax text app.log --grep 'ERROR' --count
ax text a.css --extract '#\\w{6}' --freq`}</pre>
          </article>
          <article>
            <div class='num'>05</div>
            <h3>ax enc</h3>
            <p>base64, url, hex, JWT peek, hashes. No more python -c.</p>
            <pre>{`ax enc jwt "$TOKEN"
ax enc base64 -d 'aGVsbG8='`}</pre>
          </article>
          <article>
            <div class='num'>06</div>
            <h3>ax time</h3>
            <p>epoch ⇔ ISO ⇔ timezones ⇔ relative, in one call.</p>
            <pre>{`ax time 1783332078
ax time now --tz America/New_York`}</pre>
          </article>
        </div>
      </section>

      <section class='agents'>
        <h2>Built for agents, not just humans.</h2>
        <p>
          Output is capped by default (never silently). Errors are one structured line with a hint.
          <code> --help</code> costs a few dozen tokens, and <code>ax agent-context</code> prints
          the whole playbook offline. Your agent can also learn ax from two fetchable files:
        </p>
        <div class='files'>
          <a href='/llms.txt'>
            <span>GET</span> /llms.txt — full reference for any agent
          </a>
          <a href='/skill.md'>
            <span>GET</span> /skill.md — a Claude Code skill, ready to drop in
          </a>
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
            <span class='t'>source</span>
            <code>git clone https://github.com/yusukebe/ax && cd ax && bun run build</code>
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
