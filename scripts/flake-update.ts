// Rewrite flake.nix's version + per-platform sha256 from a release's
// checksums.txt — the Nix sibling of scripts/formula.sh, run by the release
// workflow so `nix run github:yusukebe/ax` always serves the latest release.
// Usage: bun scripts/flake-update.ts <version> <checksums.txt path>

const ASSET_FOR_SYSTEM: Record<string, string> = {
  'x86_64-linux': 'ax-linux-x64',
  'aarch64-linux': 'ax-linux-arm64',
  'x86_64-darwin': 'ax-darwin-x64',
  'aarch64-darwin': 'ax-darwin-arm64',
}

// Nix's base32: custom alphabet, characters emitted from the last 5-bit
// group down to the first. Verified against nix-prefetch output.
const NIX_ALPHABET = '0123456789abcdfghijklmnpqrsvwxyz'

function nixBase32(hex: string): string {
  const bytes = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)))
  const len = Math.ceil((bytes.length * 8) / 5)
  let out = ''
  for (let i = len - 1; i >= 0; i--) {
    const bit = i * 5
    const byte = Math.floor(bit / 8)
    const off = bit % 8
    const c = (bytes[byte]! >> off) | (byte + 1 < bytes.length ? bytes[byte + 1]! << (8 - off) : 0)
    out += NIX_ALPHABET[c & 0x1f]
  }
  return out
}

const [version, checksumsPath] = process.argv.slice(2)
if (!version || !checksumsPath) {
  console.error('usage: bun scripts/flake-update.ts <version> <checksums.txt>')
  process.exit(1)
}

const sums = new Map<string, string>()
for (const line of (await Bun.file(checksumsPath).text()).trim().split('\n')) {
  const [hex, name] = line.trim().split(/\s+/)
  if (hex && name) sums.set(name, hex)
}

let flake = await Bun.file('flake.nix').text()

const versioned = flake.replace(/version = "[^"]*";/, `version = "${version}";`)
if (versioned === flake && !flake.includes(`version = "${version}";`)) {
  console.error('flake-update: could not find version = "..." in flake.nix')
  process.exit(1)
}
flake = versioned

for (const [system, asset] of Object.entries(ASSET_FOR_SYSTEM)) {
  const hex = sums.get(asset)
  if (!hex) {
    console.error(`flake-update: ${asset} missing from ${checksumsPath}`)
    process.exit(1)
  }
  const block = new RegExp(`("${system}" = \\{[^}]*sha256 = ")[^"]*(")`, 's')
  const next = flake.replace(block, `$1${nixBase32(hex)}$2`)
  if (next === flake && !flake.includes(nixBase32(hex))) {
    console.error(`flake-update: could not find the ${system} assets block in flake.nix`)
    process.exit(1)
  }
  flake = next
}

await Bun.write('flake.nix', flake)
console.log(`flake.nix -> ${version} (${Object.keys(ASSET_FOR_SYSTEM).length} hashes updated)`)
