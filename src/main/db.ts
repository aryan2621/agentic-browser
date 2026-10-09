import Database from 'better-sqlite3'
import type { Bookmark, HistoryEntry, SavedPassword, SitePermission } from '@shared/types'

const SCHEMA_VERSION = 5

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    visited_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_visited ON history(visited_at DESC);
  CREATE TABLE IF NOT EXISTS summaries (
    url TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    mode TEXT NOT NULL,
    model TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (url, content_hash, mode, model)
  );
  CREATE TABLE IF NOT EXISTS embeddings (
    url TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    vector BLOB NOT NULL,
    PRIMARY KEY (url, content_hash, model, chunk_index)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS site_permissions (
    origin TEXT NOT NULL,
    permission TEXT NOT NULL,
    allow INTEGER NOT NULL,
    PRIMARY KEY (origin, permission)
  );
  CREATE INDEX IF NOT EXISTS idx_history_url ON history(url);
  `,
  `
  CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE VIRTUAL TABLE IF NOT EXISTS history_text USING fts5(url UNINDEXED, title, body, visited_at UNINDEXED);
  `,
  `
  CREATE TABLE IF NOT EXISTS passwords (
    origin TEXT NOT NULL,
    username TEXT NOT NULL,
    secret BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (origin, username)
  );
  CREATE TABLE IF NOT EXISTS password_never (origin TEXT PRIMARY KEY);
  `
]

export interface StoredChunk {
  index: number
  text: string
  vector: Float32Array
}

export class AppDatabase {
  private readonly db: Database.Database

  constructor(file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number
    for (let v = current; v < SCHEMA_VERSION; v++) {
      const sql = MIGRATIONS[v]
      if (sql) this.db.exec(sql)
    }
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
  }

  close(): void {
    this.db.close()
  }

  // ------------------------------------------------------------ settings

  getSetting(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined
    if (!row) return undefined
    try {
      return JSON.parse(row.value) as unknown
    } catch {
      return undefined
    }
  }

  getAllSettings(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string
      value: string
    }>
    const out: Record<string, unknown> = {}
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value) as unknown
      } catch {
        /* ignore corrupt values; defaults apply */
      }
    }
    return out
  }

  setSettings(values: Record<string, unknown>): void {
    const stmt = this.db.prepare(
      'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    const tx = this.db.transaction((entries: Array<[string, unknown]>) => {
      for (const [k, v] of entries) stmt.run(k, JSON.stringify(v))
    })
    tx(Object.entries(values))
  }

  // ------------------------------------------------------------ history

  addHistory(url: string, title: string): void {
    // Collapse reloads / title updates of the same page within a minute.
    const last = this.db
      .prepare('SELECT id, url, visited_at FROM history ORDER BY id DESC LIMIT 1')
      .get() as { id: number; url: string; visited_at: number } | undefined
    const now = Date.now()
    if (last && last.url === url && now - last.visited_at < 60_000) {
      this.db
        .prepare('UPDATE history SET title = ?, visited_at = ? WHERE id = ?')
        .run(title, now, last.id)
      return
    }
    this.db
      .prepare('INSERT INTO history(url, title, visited_at) VALUES (?, ?, ?)')
      .run(url, title, now)
  }

  updateHistoryTitle(url: string, title: string): void {
    this.db
      .prepare(
        'UPDATE history SET title = ? WHERE id = (SELECT id FROM history WHERE url = ? ORDER BY id DESC LIMIT 1)'
      )
      .run(title, url)
  }

  listHistory(query: string | undefined, limit: number, offset = 0): HistoryEntry[] {
    const rows = (
      query
        ? this.db
            .prepare(
              `SELECT id, url, title, visited_at FROM history
               WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
               ORDER BY visited_at DESC LIMIT ? OFFSET ?`
            )
            .all(`%${escapeLike(query)}%`, `%${escapeLike(query)}%`, limit, offset)
        : this.db
            .prepare(
              'SELECT id, url, title, visited_at FROM history ORDER BY visited_at DESC LIMIT ? OFFSET ?'
            )
            .all(limit, offset)
    ) as Array<{ id: number; url: string; title: string; visited_at: number }>
    return rows.map((r) => ({ id: r.id, url: r.url, title: r.title, visitedAt: r.visited_at }))
  }

  /**
   * Address-bar suggestions: pages whose URL or title matches, most visited and most recent
   * first. Pages whose host starts with the input come first (they can be inline-completed).
   */
  suggestHistory(query: string, limit: number): HistoryEntry[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const like = `%${escapeLike(q)}%`
    const rows = this.db
      .prepare(
        `SELECT MAX(id) AS id, url, title, MAX(visited_at) AS visited_at, COUNT(*) AS visits
         FROM history WHERE lower(url) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\'
         GROUP BY url ORDER BY visits DESC, visited_at DESC LIMIT 200`
      )
      .all(like, like) as Array<{
      id: number
      url: string
      title: string
      visited_at: number
      visits: number
    }>
    const bare = (url: string): string => url.replace(/^https?:\/\/(www\.)?/i, '').toLowerCase()
    const score = (r: (typeof rows)[number]): number =>
      (bare(r.url).startsWith(q) ? 1000 : 0) + Math.min(r.visits, 50) * 10 + r.visited_at / 1e12
    return rows
      .sort((a, b) => score(b) - score(a))
      .slice(0, limit)
      .map((r) => ({ id: r.id, url: r.url, title: r.title, visitedAt: r.visited_at }))
  }

  deleteHistory(id: number): void {
    const row = this.db.prepare('SELECT url FROM history WHERE id = ?').get(id) as
      { url: string } | undefined
    if (row) this.db.prepare('DELETE FROM history WHERE url = ?').run(row.url)
  }

  // ---------------------------------------------------------------- AI history index

  /** Store a visited page's text for "Ask about your history" (keeps the newest `cap` pages). */
  indexHistoryPage(url: string, title: string, body: string, cap: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM history_text WHERE url = ?').run(url)
      this.db
        .prepare('INSERT INTO history_text(url, title, body, visited_at) VALUES (?, ?, ?, ?)')
        .run(url, title, body, Date.now())
      this.db
        .prepare(
          'DELETE FROM history_text WHERE rowid NOT IN (SELECT rowid FROM history_text ORDER BY visited_at DESC LIMIT ?)'
        )
        .run(cap)
    })()
  }

  /** When the page was last indexed (ms), or null. */
  historyIndexedAt(url: string): number | null {
    const row = this.db.prepare('SELECT visited_at FROM history_text WHERE url = ?').get(url) as
      { visited_at: number } | undefined
    return row ? row.visited_at : null
  }

  /** Best keyword matches (BM25) for a question. */
  searchHistoryText(
    question: string,
    limit: number
  ): Array<{ url: string; title: string; body: string; visitedAt: number }> {
    const terms = (question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 12)
    if (terms.length === 0) return []
    const match = terms.map((t) => `"${t}"`).join(' OR ')
    const rows = this.db
      .prepare(
        'SELECT url, title, body, visited_at FROM history_text WHERE history_text MATCH ? ORDER BY bm25(history_text) LIMIT ?'
      )
      .all(match, limit) as Array<{ url: string; title: string; body: string; visited_at: number }>
    return rows.map((r) => ({ url: r.url, title: r.title, body: r.body, visitedAt: r.visited_at }))
  }

  historyIndexSize(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM history_text').get() as { n: number }).n
  }

  clearHistoryIndex(): void {
    this.db.prepare('DELETE FROM history_text').run()
  }

  // ---------------------------------------------------------------- passwords (encrypted)

  listPasswords(): SavedPassword[] {
    const rows = this.db
      .prepare('SELECT origin, username, updated_at FROM passwords ORDER BY origin, username')
      .all() as Array<{ origin: string; username: string; updated_at: number }>
    return rows.map((r) => ({ origin: r.origin, username: r.username, updatedAt: r.updated_at }))
  }

  /** Newest first. `secret` is encrypted with the OS keychain. */
  getPasswords(origin: string): Array<{ username: string; secret: Buffer }> {
    return this.db
      .prepare('SELECT username, secret FROM passwords WHERE origin = ? ORDER BY updated_at DESC')
      .all(origin) as Array<{ username: string; secret: Buffer }>
  }

  savePassword(origin: string, username: string, secret: Buffer): void {
    this.db
      .prepare(
        `INSERT INTO passwords(origin, username, secret, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(origin, username) DO UPDATE SET secret = excluded.secret, updated_at = excluded.updated_at`
      )
      .run(origin, username, secret, Date.now())
  }

  deletePassword(origin: string, username: string): void {
    this.db.prepare('DELETE FROM passwords WHERE origin = ? AND username = ?').run(origin, username)
  }

  isPasswordNever(origin: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM password_never WHERE origin = ?').get(origin) !== undefined
    )
  }

  setPasswordNever(origin: string): void {
    this.db.prepare('INSERT OR IGNORE INTO password_never(origin) VALUES (?)').run(origin)
  }

  // ---------------------------------------------------------------- bookmarks

  listBookmarks(): Bookmark[] {
    const rows = this.db
      .prepare('SELECT id, url, title, created_at FROM bookmarks ORDER BY id')
      .all() as Array<{ id: number; url: string; title: string; created_at: number }>
    return rows.map((r) => ({ id: r.id, url: r.url, title: r.title, createdAt: r.created_at }))
  }

  /** Bookmark the page, or remove its bookmark if it has one. Returns whether it is bookmarked. */
  toggleBookmark(url: string, title: string): boolean {
    const found = this.db.prepare('SELECT id FROM bookmarks WHERE url = ?').get(url)
    if (found) {
      this.db.prepare('DELETE FROM bookmarks WHERE url = ?').run(url)
      return false
    }
    this.db
      .prepare('INSERT INTO bookmarks(url, title, created_at) VALUES (?, ?, ?)')
      .run(url, title.slice(0, 300) || url, Date.now())
    return true
  }

  deleteBookmark(id: number): void {
    this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id)
  }

  renameBookmark(id: number, title: string): void {
    this.db.prepare('UPDATE bookmarks SET title = ? WHERE id = ?').run(title.slice(0, 300), id)
  }

  clearHistory(): void {
    this.db.prepare('DELETE FROM history').run()
  }

  /** History plus everything derived from visited pages (summaries, embeddings). */
  clearBrowsingData(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM history').run()
      this.db.prepare('DELETE FROM summaries').run()
      this.db.prepare('DELETE FROM embeddings').run()
      this.db.prepare('DELETE FROM history_text').run()
    })()
  }

  // ------------------------------------------------------------ site permissions

  getSitePermission(origin: string, permission: string): boolean | null {
    const row = this.db
      .prepare('SELECT allow FROM site_permissions WHERE origin = ? AND permission = ?')
      .get(origin, permission) as { allow: number } | undefined
    return row ? row.allow === 1 : null
  }

  setSitePermission(origin: string, permission: string, allow: boolean): void {
    this.db
      .prepare(
        `INSERT INTO site_permissions(origin, permission, allow) VALUES (?, ?, ?)
         ON CONFLICT(origin, permission) DO UPDATE SET allow = excluded.allow`
      )
      .run(origin, permission, allow ? 1 : 0)
  }

  listSitePermissions(): SitePermission[] {
    const rows = this.db
      .prepare('SELECT origin, permission, allow FROM site_permissions ORDER BY origin, permission')
      .all() as Array<{ origin: string; permission: string; allow: number }>
    return rows.map((r) => ({ origin: r.origin, permission: r.permission, allow: r.allow === 1 }))
  }

  clearSitePermissions(origin?: string): void {
    if (origin) this.db.prepare('DELETE FROM site_permissions WHERE origin = ?').run(origin)
    else this.db.prepare('DELETE FROM site_permissions').run()
  }

  // ------------------------------------------------------------ summaries cache

  getSummary(url: string, hash: string, mode: string, model: string): string | null {
    const row = this.db
      .prepare(
        'SELECT content FROM summaries WHERE url = ? AND content_hash = ? AND mode = ? AND model = ?'
      )
      .get(url, hash, mode, model) as { content: string } | undefined
    return row?.content ?? null
  }

  putSummary(url: string, hash: string, mode: string, model: string, content: string): void {
    this.db
      .prepare(
        `INSERT INTO summaries(url, content_hash, mode, model, content, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(url, content_hash, mode, model) DO UPDATE SET content = excluded.content, created_at = excluded.created_at`
      )
      .run(url, hash, mode, model, content, Date.now())
  }

  // ------------------------------------------------------------ embeddings

  getChunks(url: string, hash: string, model: string): StoredChunk[] {
    const rows = this.db
      .prepare(
        'SELECT chunk_index, text, vector FROM embeddings WHERE url = ? AND content_hash = ? AND model = ? ORDER BY chunk_index'
      )
      .all(url, hash, model) as Array<{ chunk_index: number; text: string; vector: Buffer }>
    return rows.map((r) => ({
      index: r.chunk_index,
      text: r.text,
      vector: new Float32Array(
        r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength)
      )
    }))
  }

  putChunks(url: string, hash: string, model: string, chunks: StoredChunk[]): void {
    const del = this.db.prepare('DELETE FROM embeddings WHERE url = ? AND model = ?')
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO embeddings(url, content_hash, model, chunk_index, text, vector) VALUES (?, ?, ?, ?, ?, ?)'
    )
    this.db.transaction(() => {
      del.run(url, model)
      for (const c of chunks) {
        ins.run(
          url,
          hash,
          model,
          c.index,
          c.text,
          Buffer.from(c.vector.buffer, c.vector.byteOffset, c.vector.byteLength)
        )
      }
    })()
  }
}

/** Escape LIKE wildcards so a search for "100%" or "a_b" matches literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}
