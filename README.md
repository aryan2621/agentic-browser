# Agentic Browser

**A web browser whose AI never leaves your computer.**

Agentic Browser is a desktop browser with an AI assistant built in, and the AI runs entirely on
your machine. Open models (Qwen, Llama, Whisper) are embedded in the app. There is no cloud, no
account, no API key and no telemetry: the pages you read, the questions you ask and the words you
speak stay on your computer.

It is a normal browser first (tabs, bookmarks, history, downloads, incognito, saved passwords) with
an assistant that can read, compare, answer and do small tasks for you.

---

## What you can do

### Read faster

- **Summarize any page** or a selection: a short summary or a detailed one, optionally focused on
  what you care about ("prices and dates"). PDFs work too.
- **Chat with a page**: answers quote the page and say so when the page doesn't contain the answer.

### Ask across tabs

- **Chat with several tabs at once**: pick "All open tabs" or choose a few. Answers cite each tab
  as [1], [2]… and a click on a citation jumps to that tab.
- **Compare with AI**: right-click a tab and compare it with another tab or all of them. You get a
  verdict, a comparison table and the main differences.

### Ask the web, with sources

- **AI tabs**: ask a question instead of typing an address. The browser searches the web, reads the
  top results and writes an answer **only from those sources**, with numbered citations.
- Three styles: **Quick answer**, **Detailed**, **Compare** (with a table).
- **Follow-up questions** reuse the same sources. If they don't cover it, one click searches again.

### Let it do small tasks

- **Local agent**: "open this site, find the contact page and tell me the email", "fill this form
  with my details". An _actor_ picks one step at a time and a _checker_ verifies each step.
- Every step is shown live; **Stop**, **Resume** or **Delete** at any time.
- Safe by design: it never presses a submit button (you do), and it stops on sign-in and payment
  pages.

### Remember what you read

- **Ask about your history** (opt-in): "that article about solar panels last week". The text of
  pages you visit is kept on your computer and answers link back to them.
- **Bookmarks**, a bookmarks bar, and a History / Bookmarks / Downloads page with search and paging.

### Talk instead of type

- **Voice input** everywhere there is a text box (search, chat, agent), transcribed locally with
  Whisper.

### Browse privately

- **Ad and tracker blocking** built in (EasyList, EasyPrivacy, uBlock Origin lists).
- **Incognito windows**: nothing is saved to history or disk, cookies vanish when the window closes.
- **Password manager**: passwords are encrypted with your system keychain and filled in for you.
- **Site permissions** (camera, microphone, location, notifications) are asked once per site.

---

## Why local?

|                                        | Agentic Browser                            | Cloud AI browsers         |
| -------------------------------------- | ------------------------------------------ | ------------------------- |
| Where the AI runs                      | On your computer                           | On someone else's servers |
| What leaves your machine               | Only normal web traffic                    | Pages, questions, voice   |
| Works offline (summaries, chat, voice) | Yes                                        | No                        |
| Account / API key / subscription       | None                                       | Usually                   |
| Answers grounded in sources            | Always cited; says "the sources don't say" | Varies                    |

The trade-off is speed and size: local models are smaller than cloud models, so the app keeps tasks
focused (summaries, grounded answers, simple agent steps) where small models do well.

---

## Install

Download the latest build from **[Releases](../../releases)**:

| Platform              | File                  |
| --------------------- | --------------------- |
| macOS (Apple Silicon) | `.dmg`                |
| Windows               | `.exe` installer      |
| Linux                 | `.AppImage` or `.deb` |

The builds are **not code-signed** yet:

- **macOS:** right-click the app → **Open** the first time (or run
  `xattr -dr com.apple.quarantine "/Applications/Agentic Browser.app"`).
- **Windows:** SmartScreen may warn; choose **More info → Run anyway**.

On first launch the app checks your hardware and suggests models to download (one-time, from
Hugging Face). After that, the AI works offline.

**Hardware:** 8 GB RAM works (smaller model); 16 GB RAM or a GPU with 8 GB+ VRAM is recommended.
Apple Silicon (Metal), NVIDIA (CUDA), Vulkan and plain CPU are supported.

---

## How it works

```
Electron browser shell
├─ Web pages ........ sandboxed tabs, ad blocking, permissions, incognito sessions
├─ UI (React) ....... tabs, AI tabs, side panel (Summary · Chat · Agent), settings
└─ Main process
   ├─ llama.cpp ..... local LLM in a separate process (summaries, chat, answers, agent)
   ├─ Whisper ....... local speech to text
   ├─ SQLite ........ history, bookmarks, caches, encrypted passwords, local history search
   └─ Search ........ DuckDuckGo results, read and cited by the local model
```

Every AI answer is built from text the app actually read (a page, your tabs, search results or
your history) and the model is instructed to use nothing else and to cite it.

---

## Build from source

Requires Node.js 22+.

```bash
npm install
npm run dev              # run in development
npm run package:mac      # or package:win / package:linux → installers in dist/
```

Every push to `main` builds macOS, Windows and Linux installers and publishes them as a GitHub
Release (see `.github/workflows/release.yml`).

---

## Status

Agentic Browser is an early release (0.x). Known open items: some Cloudflare "verify you are
human" checks loop, the agent only handles simple tasks, and builds aren't code-signed.

## License

MIT. Model weights are downloaded separately and keep their own licenses (Llama community license,
Apache-2.0, MIT), shown before download.
