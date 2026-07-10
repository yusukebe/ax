// Generate src/og.png (1200x630) from an inline SVG at build time.
// Run: bun og.ts   (gen.ts embeds the result into content.gen.ts)
import { Resvg } from '@resvg/resvg-js'

const ROUND = `'Hiragino Maru Gothic ProN', 'Arial Rounded MT Bold', Helvetica, sans-serif`

const svg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#fff7ec"/>

  <!-- ax mark -->
  <g transform="rotate(-2 155 130)">
    <rect x="72" y="72" width="166" height="116" rx="26" fill="#ff5c1a"/>
    <text x="155" y="154" text-anchor="middle" font-family="${ROUND}" font-size="78" font-weight="800" letter-spacing="-3" fill="#ffffff">ax</text>
  </g>

  <!-- headline -->
  <text x="76" y="330" font-family="${ROUND}" font-size="74" font-weight="800" letter-spacing="-2" fill="#46372d">The AI-era <tspan fill="#a08d7c">curl</tspan></text>
  <rect x="466" y="304" width="152" height="9" rx="4" fill="#ff5c1a"/>
  <text x="76" y="420" font-family="${ROUND}" font-size="44" font-weight="700" letter-spacing="-1" fill="#6b5a4c">fetch, discover, extract. One command.</text>

  <!-- the axe mascot (no face) -->
  <g transform="translate(850 96) scale(2.7)">
    <g transform="rotate(22 60 65)">
      <rect x="58" y="34" width="15" height="88" rx="8" fill="#fff3e0" stroke="#46372d" stroke-width="4.5"/>
      <path d="M76 28 L38 23 C26 21 14 13 12 14 C5 36 5 56 12 78 C14 79 26 70 38 66 L76 50 Z" fill="#ff5c1a" stroke="#46372d" stroke-width="4.5" stroke-linejoin="round"/>
      <path d="M17 26 C12 42 12 52 17 66" stroke="#ffffff" opacity=".4" stroke-width="5.5" fill="none" stroke-linecap="round"/>
    </g>
  </g>

  <!-- install pill -->
  <rect x="76" y="492" width="800" height="64" rx="32" fill="#fffdf9" stroke="#f3e2cd" stroke-width="4"/>
  <text x="108" y="533" font-family="Menlo, monospace" font-size="24" fill="#ff5c1a">$</text>
  <text x="136" y="533" font-family="Menlo, monospace" font-size="24" fill="#46372d">curl -fsSL https://ax.yusuke.run/install | sh</text>
</svg>`

const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng()
await Bun.write(new URL('src/og.png', import.meta.url), png)
console.log(`wrote src/og.png (${png.length} bytes)`)

// PNG favicons — Safari does not render SVG data-URI favicons, so the tab
// icon needs a raster fallback. Same axe as the site header/hero.
const axeSvg = (
  size: number
) => `<svg width="${size}" height="${size}" viewBox="0 0 130 130" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(5 0) rotate(22 60 65)">
    <rect x="58" y="34" width="15" height="88" rx="8" fill="#fff3e0" stroke="#46372d" stroke-width="4.5"/>
    <path d="M76 28 L38 23 C26 21 14 13 12 14 C5 36 5 56 12 78 C14 79 26 70 38 66 L76 50 Z" fill="#ff5c1a" stroke="#46372d" stroke-width="4.5" stroke-linejoin="round"/>
    <path d="M17 26 C12 42 12 52 17 66" stroke="#ffffff" opacity=".4" stroke-width="5.5" fill="none" stroke-linecap="round"/>
  </g>
</svg>`

for (const [file, size] of [
  ['src/favicon.png', 64],
  ['src/apple-touch-icon.png', 180],
] as const) {
  const p = new Resvg(axeSvg(size), { fitTo: { mode: 'width', value: size } }).render().asPng()
  await Bun.write(new URL(file, import.meta.url), p)
  console.log(`wrote ${file} (${p.length} bytes)`)
}
