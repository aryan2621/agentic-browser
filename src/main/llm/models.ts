import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  truncate,
  writeFile
} from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import type { CatalogModel, ModelDownloadState, ModelEntry, ModelRole } from '@shared/types'

const GB = 1024 ** 3

/**
 * Default catalog. GGUF Q4_K_M builds. SHA256 values are the LFS object ids published
 * by Hugging Face for these exact files and are verified after every download.
 */
export const MODEL_CATALOG: CatalogModel[] = [
  {
    id: 'llama-3.2-3b-instruct-q4_k_m',
    name: 'Llama 3.2 3B Instruct',
    description: 'Fast, small model for summaries, chat and search answers. Runs with 8 GB RAM.',
    roles: ['fast'],
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    fileName: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sizeBytes: 2019377696,
    sha256: '6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff',
    license: 'llama3.2',
    minRamBytes: 6 * GB,
    quantization: 'Q4_K_M'
  },
  {
    id: 'llama-3.1-8b-instruct-q4_k_m',
    name: 'Llama 3.1 8B Instruct',
    description:
      'Larger Llama model: better summaries and answers. Needs 16 GB RAM or a capable GPU.',
    roles: ['fast'],
    url: 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    fileName: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    sizeBytes: 4920739232,
    sha256: '7b064f5842bf9532c91456deda288a1b672397a54fa729aa665952863033557c',
    license: 'llama3.1',
    minRamBytes: 12 * GB,
    quantization: 'Q4_K_M'
  },
  {
    id: 'qwen3-8b-q4_k_m',
    name: 'Qwen3 8B',
    description:
      'Most accurate model for summaries, chat and search answers. Needs 16 GB RAM or an 8 GB GPU.',
    roles: ['fast'],
    url: 'https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
    fileName: 'Qwen3-8B-Q4_K_M.gguf',
    sizeBytes: 5027784512,
    sha256: '120307ba529eb2439d6c430d94104dabd578497bc7bfe7e322b5d9933b449bd4',
    license: 'apache-2.0',
    minRamBytes: 12 * GB,
    quantization: 'Q4_K_M'
  },
  {
    id: 'whisper-large-v3-turbo-q5_0',
    name: 'Whisper large-v3 turbo',
    description:
      'Speech-to-text for the mic buttons. Accurate in 99 languages; fast on Apple Silicon and GPUs.',
    roles: ['speech'],
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    fileName: 'ggml-large-v3-turbo-q5_0.bin',
    sizeBytes: 574041195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    license: 'mit',
    minRamBytes: 6 * GB,
    quantization: 'Q5_0'
  },
  {
    id: 'whisper-small-q5_1',
    name: 'Whisper small',
    description: 'Lighter speech-to-text for machines with less memory. Less accurate.',
    roles: ['speech'],
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
    fileName: 'ggml-small-q5_1.bin',
    sizeBytes: 190085487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
    license: 'mit',
    minRamBytes: 2 * GB,
    quantization: 'Q5_1'
  },
  {
    id: 'nomic-embed-text-v1.5-q8_0',
    name: 'nomic-embed-text v1.5',
    description: 'Small embedding model used to find relevant parts of long pages.',
    roles: ['embed'],
    url: 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf',
    fileName: 'nomic-embed-text-v1.5.Q8_0.gguf',
    sizeBytes: 146146432,
    sha256: '3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7',
    license: 'apache-2.0',
    minRamBytes: 1 * GB,
    quantization: 'Q8_0'
  }
]

// ------------------------------------------------------------------ download core

export class ChecksumError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(`Checksum mismatch: expected ${expected}, got ${actual}. The download was discarded.`)
    this.name = 'ChecksumError'
  }
}

export class DownloadAbortedError extends Error {
  constructor() {
    super('Download aborted')
    this.name = 'AbortError'
  }
}

export interface DownloadOptions {
  url: string
  dest: string
  expectedSha256?: string
  expectedSize?: number
  signal?: AbortSignal
  onProgress?: (receivedBytes: number, totalBytes: number) => void
  fetchImpl?: typeof fetch
}

export function partPath(dest: string): string {
  return `${dest}.part`
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function hashExisting(path: string, hash: ReturnType<typeof createHash>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('end', resolve)
      .on('error', reject)
  })
}

function parseContentRangeTotal(header: string | null): number | null {
  const m = header ? /\/(\d+)\s*$/.exec(header) : null
  return m?.[1] ? Number(m[1]) : null
}

function write(stream: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = stream.write(chunk, (err) => (err ? reject(err) : undefined))
    if (ok) resolve()
    else stream.once('drain', resolve)
  })
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) =>
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()))
  )
}

/**
 * Download `url` to `dest`, resuming from `dest.part` when present (HTTP Range).
 * The SHA256 is computed incrementally (existing partial bytes are hashed first) and
 * verified before the file is moved into place. On abort the partial file is kept.
 */
export async function downloadWithResume(
  opts: DownloadOptions
): Promise<{ path: string; sha256: string; size: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const part = partPath(opts.dest)
  let existing = await fileSize(part)
  if (opts.expectedSize && existing > opts.expectedSize) {
    await rm(part, { force: true })
    existing = 0
  }

  let hash = createHash('sha256')
  if (existing > 0) await hashExisting(part, hash)

  const headers: Record<string, string> = {}
  if (existing > 0) headers.Range = `bytes=${existing}-`
  let res: Response
  try {
    res = await fetchImpl(opts.url, { headers, signal: opts.signal, redirect: 'follow' })
  } catch (err) {
    if (opts.signal?.aborted) throw new DownloadAbortedError()
    throw err
  }

  let total: number
  let append: boolean
  if (res.status === 416 && existing > 0) {
    // Range not satisfiable: we already have every byte. Go straight to verification.
    await res.body?.cancel()
    total = existing
    append = true
  } else if (res.status === 206) {
    total =
      parseContentRangeTotal(res.headers.get('content-range')) ??
      existing + Number(res.headers.get('content-length') ?? 0)
    append = true
  } else if (res.ok) {
    // Server ignored the Range header: start from scratch.
    if (existing > 0) {
      await truncate(part, 0)
      hash = createHash('sha256')
      existing = 0
    }
    total = Number(res.headers.get('content-length') ?? opts.expectedSize ?? 0)
    append = false
  } else {
    await res.body?.cancel()
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`)
  }

  let received = existing
  opts.onProgress?.(received, total)

  if (res.status !== 416 && res.body) {
    const out = createWriteStream(part, { flags: append ? 'a' : 'w' })
    try {
      const body = Readable.fromWeb(
        res.body as import('node:stream/web').ReadableStream<Uint8Array>
      )
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        hash.update(chunk)
        await write(out, chunk)
        received += chunk.byteLength
        opts.onProgress?.(received, total)
      }
    } catch (err) {
      await closeStream(out).catch(() => undefined)
      if (opts.signal?.aborted) throw new DownloadAbortedError()
      throw err
    }
    await closeStream(out)
  }

  if (opts.expectedSize && received !== opts.expectedSize) {
    throw new Error(
      `Incomplete download: got ${received} of ${opts.expectedSize} bytes. Resume to continue.`
    )
  }
  const digest = hash.digest('hex')
  if (opts.expectedSha256 && digest.toLowerCase() !== opts.expectedSha256.toLowerCase()) {
    await rm(part, { force: true })
    throw new ChecksumError(opts.expectedSha256, digest)
  }
  await rename(part, opts.dest)
  return { path: opts.dest, sha256: digest, size: received }
}

/** Check the 4-byte GGUF magic so obviously wrong files are rejected on import. */
export async function isGgufFile(path: string): Promise<boolean> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(4)
    await fh.read(buf, 0, 4, 0)
    return buf.toString('latin1') === 'GGUF'
  } finally {
    await fh.close()
  }
}

export async function freeDiskBytes(dir: string): Promise<number> {
  const s = await statfs(dir)
  return Number(s.bavail) * Number(s.bsize)
}

// ------------------------------------------------------------------ manager

interface ImportedModel {
  id: string
  name: string
  path: string
  sizeBytes: number
  roles: ModelRole[]
}

interface ActiveDownload {
  controller: AbortController
  pauseRequested: boolean
  samples: Array<{ t: number; bytes: number }>
}

const DISK_MARGIN_BYTES = 512 * 1024 * 1024

export class ModelManager extends EventEmitter<{ change: [ModelEntry[]] }> {
  private readonly states = new Map<string, ModelDownloadState>()
  private readonly active = new Map<string, ActiveDownload>()
  private imported: ImportedModel[] = []
  private lastEmit = 0

  constructor(
    readonly dir: string,
    private readonly catalog: CatalogModel[] = MODEL_CATALOG,
    private readonly fetchImpl?: typeof fetch
  ) {
    super()
  }

  private get importsFile(): string {
    return join(this.dir, 'imported.json')
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.importsFile, 'utf8')) as unknown
      if (Array.isArray(parsed)) this.imported = parsed as ImportedModel[]
    } catch {
      this.imported = []
    }
    for (const m of this.catalog) this.states.set(m.id, await this.diskState(m))
  }

  private async diskState(m: CatalogModel): Promise<ModelDownloadState> {
    const dest = join(this.dir, m.fileName)
    const size = await fileSize(dest)
    if (size > 0 && size === m.sizeBytes) return { kind: 'ready', path: dest, sizeBytes: size }
    const partial = await fileSize(partPath(dest))
    if (partial > 0) return { kind: 'paused', receivedBytes: partial, totalBytes: m.sizeBytes }
    return { kind: 'absent' }
  }

  catalogEntry(id: string): CatalogModel | undefined {
    return this.catalog.find((m) => m.id === id)
  }

  list(): ModelEntry[] {
    const fromCatalog: ModelEntry[] = this.catalog.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      roles: m.roles,
      license: m.license,
      sizeBytes: m.sizeBytes,
      quantization: m.quantization,
      imported: false,
      minRamBytes: m.minRamBytes,
      state: this.states.get(m.id) ?? { kind: 'absent' }
    }))
    const fromImports: ModelEntry[] = this.imported.map((m) => ({
      id: m.id,
      name: m.name,
      description: `Imported from ${m.path}`,
      roles: m.roles,
      license: 'unknown',
      sizeBytes: m.sizeBytes,
      quantization: 'custom',
      imported: true,
      minRamBytes: null,
      state: { kind: 'ready', path: m.path, sizeBytes: m.sizeBytes }
    }))
    return [...fromCatalog, ...fromImports]
  }

  /** Path of a ready model, or null. */
  resolvePath(id: string): string | null {
    const imported = this.imported.find((m) => m.id === id)
    if (imported) return imported.path
    const state = this.states.get(id)
    return state?.kind === 'ready' ? state.path : null
  }

  displayName(id: string): string {
    return this.catalogEntry(id)?.name ?? this.imported.find((m) => m.id === id)?.name ?? id
  }

  private setState(id: string, state: ModelDownloadState, force = true): void {
    this.states.set(id, state)
    const now = Date.now()
    if (force || now - this.lastEmit > 250) {
      this.lastEmit = now
      this.emit('change', this.list())
    }
  }

  async download(id: string): Promise<void> {
    const m = this.catalogEntry(id)
    if (!m) throw new Error(`Unknown model: ${id}`)
    if (this.active.has(id)) return
    const current = this.states.get(id)
    if (current?.kind === 'ready') return

    const dest = join(this.dir, m.fileName)
    const have = await fileSize(partPath(dest))
    const needed = m.sizeBytes - have + DISK_MARGIN_BYTES
    const free = await freeDiskBytes(this.dir)
    if (free < needed) {
      this.setState(id, {
        kind: 'error',
        message: `Not enough disk space: need ${(needed / GB).toFixed(1)} GB, ${(free / GB).toFixed(1)} GB free.`,
        receivedBytes: have
      })
      return
    }

    const job: ActiveDownload = {
      controller: new AbortController(),
      pauseRequested: false,
      samples: []
    }
    this.active.set(id, job)
    this.setState(id, {
      kind: 'downloading',
      receivedBytes: have,
      totalBytes: m.sizeBytes,
      bytesPerSecond: 0,
      etaSeconds: null
    })

    void downloadWithResume({
      url: m.url,
      dest,
      expectedSha256: m.sha256,
      expectedSize: m.sizeBytes,
      signal: job.controller.signal,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      onProgress: (received, total) => {
        const now = Date.now()
        job.samples.push({ t: now, bytes: received })
        while (job.samples.length > 2 && now - job.samples[0]!.t > 5000) job.samples.shift()
        const first = job.samples[0]!
        const dt = (now - first.t) / 1000
        const bps = dt > 0.5 ? (received - first.bytes) / dt : 0
        const totalBytes = total || m.sizeBytes
        if (received >= totalBytes) {
          this.setState(id, { kind: 'verifying', totalBytes })
          return
        }
        this.setState(
          id,
          {
            kind: 'downloading',
            receivedBytes: received,
            totalBytes,
            bytesPerSecond: bps,
            etaSeconds: bps > 0 ? (totalBytes - received) / bps : null
          },
          false
        )
      }
    })
      .then((res) => {
        this.setState(id, { kind: 'ready', path: res.path, sizeBytes: res.size })
      })
      .catch(async (err: unknown) => {
        const received = await fileSize(partPath(dest))
        if (job.controller.signal.aborted) {
          if (job.pauseRequested)
            this.setState(id, { kind: 'paused', receivedBytes: received, totalBytes: m.sizeBytes })
          else this.setState(id, { kind: 'absent' })
          return
        }
        this.setState(id, {
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
          receivedBytes: received
        })
      })
      .finally(() => {
        this.active.delete(id)
      })
  }

  pause(id: string): void {
    const job = this.active.get(id)
    if (!job) return
    job.pauseRequested = true
    job.controller.abort()
  }

  async cancel(id: string): Promise<void> {
    const m = this.catalogEntry(id)
    const job = this.active.get(id)
    if (job) {
      job.pauseRequested = false
      job.controller.abort()
      // Wait for the download loop to release the file before deleting it.
      await new Promise((r) => setTimeout(r, 100))
    }
    if (m) await rm(partPath(join(this.dir, m.fileName)), { force: true })
    this.setState(id, { kind: 'absent' })
  }

  async remove(id: string): Promise<void> {
    const importedIdx = this.imported.findIndex((m) => m.id === id)
    if (importedIdx >= 0) {
      // Imported files belong to the user; only forget the reference.
      this.imported.splice(importedIdx, 1)
      await this.saveImports()
      this.emit('change', this.list())
      return
    }
    const m = this.catalogEntry(id)
    if (!m) return
    await this.cancel(id)
    await rm(join(this.dir, m.fileName), { force: true })
    this.setState(id, { kind: 'absent' })
  }

  async importFile(path: string): Promise<ModelEntry> {
    if (!(await isGgufFile(path))) throw new Error('That file is not a GGUF model.')
    const sizeBytes = await fileSize(path)
    const id = `local-${createHash('sha1').update(path).digest('hex').slice(0, 12)}`
    const name = basename(path).replace(/\.gguf$/i, '')
    const roles: ModelRole[] = /embed/i.test(name) ? ['embed'] : ['fast']
    this.imported = this.imported.filter((m) => m.id !== id)
    this.imported.push({ id, name, path, sizeBytes, roles })
    await this.saveImports()
    this.emit('change', this.list())
    const entry = this.list().find((e) => e.id === id)
    if (!entry) throw new Error('Import failed.')
    return entry
  }

  private async saveImports(): Promise<void> {
    await writeFile(this.importsFile, JSON.stringify(this.imported, null, 2))
  }

  pauseAll(): void {
    for (const id of this.active.keys()) this.pause(id)
  }
}
