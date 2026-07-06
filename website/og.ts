// Generate src/og.png (1200x630) from an inline SVG at build time.
// Run: bun og.ts   (gen.ts embeds the result into content.gen.ts)
import { Resvg } from '@resvg/resvg-js'

const svg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#fff7ec"/>
  <!-- soft card behind the wordmark -->
  <rect x="60" y="76" width="220" height="164" rx="28" fill="#fffdf9" stroke="#f3e2cd" stroke-width="4"/>
  <text x="170" y="200" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="120" font-weight="800" letter-spacing="-6" fill="#46372d">a<tspan fill="#ff5c1a">x</tspan></text>
  <!-- headline -->
  <text x="80" y="360" font-family="Helvetica, Arial, sans-serif" font-size="66" font-weight="800" letter-spacing="-2" fill="#46372d">One binary. No more</text>
  <text x="80" y="442" font-family="Helvetica, Arial, sans-serif" font-size="66" font-weight="800" letter-spacing="-2" fill="#46372d">throwaway scripts.</text>
  <!-- prompt pill -->
  <rect x="76" y="492" width="880" height="64" rx="32" fill="#fffdf9" stroke="#f3e2cd" stroke-width="4"/>
  <text x="108" y="533" font-family="Menlo, monospace" font-size="24" fill="#ff5c1a">$</text>
  <text x="136" y="533" font-family="Menlo, monospace" font-size="24" fill="#46372d">curl -fsSL https://ax.yusuke.run/install | sh</text>
  <text x="80" y="606" font-family="Menlo, monospace" font-size="21" fill="#a08d7c">html · json · yaml · text · enc · time — a scriptless multitool for AI agents</text>
</svg>`

const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng()
await Bun.write(new URL('src/og.png', import.meta.url), png)
console.log(`wrote src/og.png (${png.length} bytes)`)
