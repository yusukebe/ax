import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Semantic embeddings for --like: quantized MiniLM running on onnxruntime-web
// (pure wasm — no native dylibs, so it works inside the compiled single-file
// binary). Deterministic: fixed weights, single thread, greedy math.
// Assets are downloaded once to ~/.cache/ax; offline afterwards.

const CACHE = join(homedir(), '.cache', 'ax')
const ORT_VERSION = '1.27.0'
// Overridable for experiments: any BERT-WordPiece embedding model in ONNX.
const MODEL = process.env.AX_EMBED_MODEL ?? 'Xenova/all-MiniLM-L6-v2'
const SLUG = MODEL.replace('/', '--')
const HF = `https://huggingface.co/${MODEL}/resolve/main`
// bge-family models use CLS pooling and a query instruction prefix.
const IS_BGE = MODEL.includes('bge')
const ASSETS = [
  { file: `${SLUG}-q8.onnx`, url: `${HF}/onnx/model_quantized.onnx`, note: 'model' },
  { file: `${SLUG}-tokenizer.json`, url: `${HF}/tokenizer.json`, note: 'tokenizer' },
  {
    file: 'ort-wasm-simd-threaded.wasm',
    url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.wasm`,
    note: 'runtime',
  },
  {
    file: 'ort-wasm-simd-threaded.mjs',
    url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.mjs`,
    note: 'runtime loader',
  },
] as const

async function ensureAssets(): Promise<void> {
  for (const a of ASSETS) {
    const path = join(CACHE, a.file)
    if (await Bun.file(path).exists()) continue
    process.stderr.write(`ax: note: downloading ${a.note} (one-time → ${path})\n`)
    const res = await fetch(a.url)
    if (!res.ok) throw new Error(`download failed (${res.status}): ${a.url}`)
    await Bun.write(path, res)
  }
}

// Minimal BERT WordPiece tokenizer (lowercase, strip accents) — enough for
// MiniLM; avoids pulling in a tokenizer library.
class WordPiece {
  private vocab: Map<string, number>
  private unk: number
  private cls: number
  private sep: number

  constructor(tokenizerJson: { model: { vocab: Record<string, number> } }) {
    this.vocab = new Map(Object.entries(tokenizerJson.model.vocab))
    this.unk = this.vocab.get('[UNK]') ?? 100
    this.cls = this.vocab.get('[CLS]') ?? 101
    this.sep = this.vocab.get('[SEP]') ?? 102
  }

  encode(text: string, maxLen = 128): number[] {
    const words =
      text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .match(/[a-z0-9]+|[^\sa-z0-9]/g) ?? []
    const ids: number[] = [this.cls]
    for (const word of words) {
      if (ids.length >= maxLen - 1) break
      let start = 0
      const pieces: number[] = []
      while (start < word.length) {
        let end = word.length
        let id: number | undefined
        while (start < end) {
          const piece = (start > 0 ? '##' : '') + word.slice(start, end)
          id = this.vocab.get(piece)
          if (id !== undefined) break
          end--
        }
        if (id === undefined) {
          pieces.length = 0
          pieces.push(this.unk)
          break
        }
        pieces.push(id)
        start = end
      }
      ids.push(...pieces)
    }
    ids.push(this.sep)
    return ids.slice(0, maxLen)
  }
}

type Embedder = (texts: string[]) => Promise<number[][]>
let embedderPromise: Promise<Embedder> | null = null

export function getEmbedder(): Promise<Embedder> {
  embedderPromise ??= (async () => {
    await ensureAssets()
    const ort = await import('onnxruntime-web/wasm')
    ort.env.wasm.numThreads = 1
    ort.env.wasm.wasmPaths = {
      wasm: pathToFileURL(join(CACHE, 'ort-wasm-simd-threaded.wasm')).href,
      mjs: pathToFileURL(join(CACHE, 'ort-wasm-simd-threaded.mjs')).href,
    }
    const tokenizer = new WordPiece(await Bun.file(join(CACHE, `${SLUG}-tokenizer.json`)).json())
    // Pass bytes, not a path: ort-web would try to fetch() a filesystem path.
    const modelBytes = new Uint8Array(await Bun.file(join(CACHE, `${SLUG}-q8.onnx`)).arrayBuffer())
    const session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ['wasm'],
    })

    return async (texts: string[]) => {
      const encoded = texts.map((t) => tokenizer.encode(t))
      const maxLen = Math.max(...encoded.map((e) => e.length))
      const B = texts.length
      const ids = new BigInt64Array(B * maxLen)
      const mask = new BigInt64Array(B * maxLen)
      const types = new BigInt64Array(B * maxLen)
      encoded.forEach((e, i) => {
        e.forEach((id, j) => {
          ids[i * maxLen + j] = BigInt(id)
          mask[i * maxLen + j] = 1n
        })
      })
      const feeds = {
        input_ids: new ort.Tensor('int64', ids, [B, maxLen]),
        attention_mask: new ort.Tensor('int64', mask, [B, maxLen]),
        token_type_ids: new ort.Tensor('int64', types, [B, maxLen]),
      }
      const out = await session.run(feeds)
      const hidden = out.last_hidden_state ?? out[session.outputNames[0]!]
      const data = hidden!.data as Float32Array
      const dim = (hidden!.dims[2] as number) ?? 384

      // Pool (CLS for bge, mean otherwise), then L2-normalize.
      return encoded.map((e, i) => {
        const vec = new Array(dim).fill(0)
        const span = IS_BGE ? 1 : e.length
        for (let j = 0; j < span; j++) {
          const off = (i * maxLen + j) * dim
          for (let d = 0; d < dim; d++) vec[d] += data[off + d]!
        }
        let norm = 0
        for (let d = 0; d < dim; d++) {
          vec[d] /= span
          norm += vec[d] * vec[d]
        }
        norm = Math.sqrt(norm) || 1
        return vec.map((v) => v / norm)
      })
    }
  })()
  return embedderPromise
}

// Vectors are normalized, so cosine similarity is a plain dot product.
export function cosSim(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot
}

export async function rankBySimilarity(
  query: string,
  lines: string[],
  batchSize = 64
): Promise<{ score: number; line: string }[]> {
  const embed = await getEmbedder()
  const q = MODEL.includes('bge')
    ? `Represent this sentence for searching relevant passages: ${query}`
    : query
  const [queryVec] = await embed([q])
  const scored: { score: number; line: string }[] = []
  for (let i = 0; i < lines.length; i += batchSize) {
    const batch = lines.slice(i, i + batchSize)
    const vecs = await embed(batch)
    for (let j = 0; j < batch.length; j++) {
      scored.push({ score: cosSim(queryVec!, vecs[j]!), line: batch[j]! })
    }
  }
  return scored.sort((a, b) => b.score - a.score)
}
