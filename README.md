# Agentic Browser

A desktop web browser with an AI assistant that runs **entirely on your computer**. The open models (Llama, Qwen, Whisper) are embedded in the app. There is no Ollama, no cloud and no API key, and your pages, questions and voice never leave the machine.

**Every tab is either a browser tab or an AI tab.** A new tab's search box has a **Browser / AI** choice, and the tab continues the way you pick:

- **Browser tab:** a normal browser (tabs that restore, find, zoom, downloads, permission prompts) with an AI side panel.
- **History, Bookmarks & Downloads:** the clock icon before Settings (or ⌘Y / ⌥⌘B / ⌥⌘L) opens them in their own tab, grouped by day and paginated, with search, rename/delete and clear.
- **Windows:** ⌘N opens a new window, ⌘⇧N an **incognito** window (in-memory cookies and storage, no history, no saved passwords, no AI history index, an "Incognito" badge; site permissions are denied and the ad blocker is off there). Closing a window's last tab closes the window. Next launch restores the tabs of all normal windows into one window.
- **Passwords:** after you sign in on an https site, a prompt offers to save the password (Save / Not now / Never for this site). Passwords are encrypted with the system keychain (`safeStorage`) and filled in automatically next time. **Settings → Privacy → Saved passwords** lists and deletes them; the UI never sees a password.
- **Bookmarks:** the star in the address bar or ⌘D adds or removes one; the bookmarks bar under the toolbar (⌘⇧B shows or hides it) opens them in the current tab (⌘-click for a new tab).
- **Ask about your history (opt-in):** in the History tab, switch it on to keep visited pages' text on this computer (newest 3,000 pages, full-text search). Answers come only from those pages and cite them. "Clear AI history index" and Clear browsing data delete it.
  - **Summary:** summarize the page or a selection. Summary or Detailed, with an optional focus, streamed live, cached.
  - **Chat:** ask about the page you're reading, or across several open tabs. Answers quote the page, and local embeddings find the right parts of long pages.
  - **Agent:** give a simple task ("open a site, click X, find Y, fill this form"); a local actor picks one step at a time from the page's numbered controls and a checker verifies each step. Every step shows in a log, **Stop** ends it, it never submits forms (you press submit) and it stops on sign-in and payment pages. At most 15 steps.
- **AI tab** (pick **AI** on a new tab, or ⌘/Ctrl+K): type or say a question; the tab shows the answer instead of a web page.
  - **AI result:** an answer written by your local model only from the top web results, with numbered citations.
  - **Results:** the links behind the answer.
  - **Images, Videos, News, Maps:** open DuckDuckGo's (or OpenStreetMap's) page for the question in a new tab.

**Also built in:**

- **Speech to text:** the mic buttons transcribe your voice locally with Whisper.
- **Ad and tracker blocking:** EasyList, EasyPrivacy and uBlock Origin's lists and scriptlets (including YouTube video ads), bundled with the app.

Built with Electron (`WebContentsView` tabs), React, TypeScript, **llama.cpp via `node-llama-cpp`** and **whisper.cpp via `@fugood/whisper.node`**. Both run in Electron utility processes.

What isn't built yet is listed in **[FUTURE.md](FUTURE.md)**. The design trade-offs are in **[DECISIONS.md](DECISIONS.md)**.

---

## Quick start

```bash
npm install
npm run dev            # development with hot reload
```

Requirements: Node.js ≥ 22.12 (tested with 24), macOS 12+, Windows 10+ or a modern Linux.

> **If your npm config has `ignore-scripts=true`**, run these once after `npm install`:
>
> ```bash
> node node_modules/electron/install.js        # downloads the Electron binary
> npx electron-builder install-app-deps        # native deps for Electron (no-op for N-API prebuilds)
> ```
>
> `better-sqlite3`, `node-llama-cpp` and `@fugood/whisper.node` ship prebuilt N-API binaries, so no compiler is needed.

### Run without any model (mock)

```bash
AB_LLM_PROVIDER=mock npm run dev
```

The `MockProvider` produces deterministic text from the page, which is useful for UI work. Speech to text still needs a Whisper model. This environment variable is the only way to use the mock (it is ignored in packaged builds, and there is no Settings switch).

### First run

1. **Hardware check:** RAM, CPU and GPU backend (Metal, CUDA, Vulkan or CPU), with recommended models.
2. **Licenses:** the Llama Community License must be accepted before downloading a Llama model.
3. **Download:** progress, speed and ETA, pause/resume/cancel, a disk-space check, and SHA-256 verification.
4. **Ready**, then a 3-step tour.

You can skip setup, import any local `.gguf`, or keep browsing while downloads finish.

## Models

Settings and onboarding only offer models **this computer can run**. A model whose memory requirement exceeds your RAM (or VRAM on a discrete GPU) is hidden, with a note saying how many were hidden.

| Role                    | Catalog models                                           | Size               | Recommended when                   |
| ----------------------- | -------------------------------------------------------- | ------------------ | ---------------------------------- |
| Summaries, chat, search | **Qwen3 8B** (Q4_K_M) · Llama 3.2 3B · Llama 3.1 8B      | 4.7 / 1.9 / 4.6 GB | Qwen3 8B with ≥ 16 GB RAM, else 3B |
| Speech to text          | **Whisper large-v3 turbo** (Q5_0) · Whisper small (Q5_1) | 547 / 181 MB       | turbo with ≥ 7 GB RAM              |
| Embeddings (retrieval)  | nomic-embed-text v1.5 (Q8_0)                             | 139 MB             | always                             |

- Downloaded from Hugging Face on request, and **never bundled** in the installer.
- Stored in `<userData>/models`:
  - macOS: `~/Library/Application Support/Agentic Browser/models`
  - Windows: `%APPDATA%\Agentic Browser\models`
  - Linux: `~/.config/Agentic Browser/models`
- Interrupted downloads resume using HTTP Range requests. Every file is checked against the SHA-256 that Hugging Face publishes, and a mismatch deletes it.
- **Settings → Models** lets you assign a model to each role, import any `.gguf` (referenced in place, not copied), delete models, and open the folder. An imported model gets one role: embeddings if its file name contains "embed", otherwise summaries, chat and search.

### Hardware guidance

- **Minimum:** 8 GB RAM, for the 3B model and Whisper small.
- **Recommended:** 16 GB RAM or a GPU with ≥ 8 GB VRAM, for Qwen3 8B and Whisper turbo.
- **Context window:** 8,192 tokens by default (Settings → Performance). The worker shrinks it to what memory allows (minimum 2,048), and GPU layers are sized for the configured context.
- **Idle unload:** models unload after 10 idle minutes by default; Whisper unloads after 5. The next use shows "Model loading…". Only one large generation model is loaded at a time.

### GPU backends

| Platform                           | Backend    | Notes                                             |
| ---------------------------------- | ---------- | ------------------------------------------------- |
| macOS Apple Silicon                | **Metal**  | Prebuilt. Unified memory, so most layers offload. |
| Windows / Linux + NVIDIA           | **CUDA**   | Prebuilt for CUDA 12. Needs a recent driver.      |
| Windows / Linux + AMD/Intel/NVIDIA | **Vulkan** | Prebuilt. Needs Vulkan drivers.                   |
| Anything else                      | **CPU**    | Always works; slower.                             |

- If loading on the GPU fails, the model reloads on CPU automatically, and the footer shows **CPU (GPU fallback)**.
- **Settings → Performance → GPU acceleration: Off** forces CPU.
- Only the prebuilt llama.cpp binaries shipped with the app are used. llama.cpp is never downloaded or compiled at runtime.
- The panel footer shows the active model, backend, layers, context, RAM/VRAM use and tokens/sec.

## Usage

| Action                   | macOS                  | Windows / Linux                    |
| ------------------------ | ---------------------- | ---------------------------------- |
| New AI tab               | ⌘K                     | Ctrl+K                             |
| Tabs 1–8 / last tab      | ⌘1…⌘8 / ⌘9             | Ctrl+1…8 / Ctrl+9                  |
| Next / previous tab      | Ctrl+Tab, ⌥⌘→/←, ⇧⌘]/[ | Ctrl+Tab, Ctrl+PgDn/PgUp           |
| New tab / close tab      | ⌘T, ⌘W                 | Ctrl+T, Ctrl+W                     |
| Reopen closed tab        | ⇧⌘T                    | Ctrl+Shift+T                       |
| Focus address bar        | ⌘L                     | Ctrl+L                             |
| Reload / hard reload     | ⌘R, ⇧⌘R                | Ctrl+R, F5 / Ctrl+Shift+R, Ctrl+F5 |
| Back / forward           | ⌘[ and ⌘]              | Ctrl+[ and ], Alt+←/→              |
| Find / next / previous   | ⌘F, ⌘G, ⇧⌘G            | Ctrl+F, F3, Shift+F3               |
| Zoom in / out / reset    | ⌘+, ⌘−, ⌘0             | Ctrl+Plus, Ctrl+−, Ctrl+0          |
| Print                    | ⌘P                     | Ctrl+P                             |
| View page source         | ⌥⌘U                    | Ctrl+U                             |
| Downloads                | ⌥⌘L                    | Ctrl+J                             |
| Toggle AI panel          | ⇧⌘A                    | Ctrl+Shift+A                       |
| Summary / Chat / History | ⇧⌘S / ⇧⌘C / ⌘Y         | Ctrl+Shift+S / C / Ctrl+H          |
| Settings                 | ⌘,                     | Ctrl+,                             |

On macOS, ⌥←/→ moves by word in text fields, as in other Mac apps; it doesn't go back or forward.

### Browser features

- **Tabs:** the strip scrolls when there are many tabs and keeps the active one in view. Right-click a tab for New Tab, Reload, Duplicate, Mute Site, Close, Close Other Tabs, Close Tabs to the Right and Reopen Closed Tab. A speaker icon on a tab playing sound mutes it.
- **Quitting and restoring:** closing the last tab quits the app. After a normal quit (⌘Q), your tabs reopen on the next launch and load when you first select them. Closing the last tab starts the next launch with one new tab.
- **Address bar:** suggestions from your history as you type, with inline completion. Plain `http://` pages show "Not secure".
- **Find, zoom, print, view source:** from the menu or the shortcuts above. The zoom level shows in the address bar.
- **Error and crash pages:** a page that fails to load or crashes shows an error page; Reload loads the real address again.
- **Prompts in a strip above the page** (never a modal dialog):
  - Sites ask before using your location, notifications, camera or microphone. Your answer is remembered per site; **Settings → Privacy → Site permissions** lists and resets them.
  - `mailto:` and other external links ask before opening another app.
  - Sites that need HTTP sign-in show a username and password prompt.
- **Downloads** (⌥⌘L / Ctrl+J): progress, Open and Show in Folder.

### Browser tabs

- **Summarize:**
  - Pick a style from the dropdown: **Summary** (TL;DR, key points, facts, why it matters) or **Detailed** (every section).
  - Optionally type what to **Focus on…** (for example "prices and dates"); it works with either style. Leave it empty for a general summary.
  - Then press **Summarize page**.
  - Output sections: TL;DR, key points, notable facts & numbers, and why it matters.
  - Results are cached by `(url, content hash, style + focus, model)` and marked **cached**.
  - The result header has **Regenerate**, **Copy** and **Export (Markdown)**. **Stop** cancels.
- **Summarize a selection:** select text, right-click, and choose _Summarize selection_ or _Ask AI about selection_. Regenerate re-summarizes the same selection.
- **Long pages** are chunked by headings and paragraphs (about 2.5k tokens, with overlap) and summarized map-reduce. PDFs are read through PDF.js.
- **Chat:**
  - Answers come from the page, with short quotes, and say so when the page doesn't contain the answer.
  - History is kept per tab. Long conversations are trimmed so the page always fits.
  - Click the **mic** to dictate a question.
  - **Compare with AI** (right-click a tab): compare it with all open tabs or one other tab; the comparison (verdict, table, differences) appears in that tab's Chat.
  - **Use: This tab / All open tabs / Pick tabs** (above the conversation). With several tabs, each tab's most relevant passages get an equal share of the context (up to 8 tabs; fewer if the context is small), the answer cites them as [1], [2]… and lists the tabs read, and clicking a citation switches to that tab. Tabs restored but not yet loaded are loaded in the background first. If the tabs don't answer the question, it says "The tabs don't say."
- **Language:** answers follow the page or question language, unless you set one in Settings.

### AI tabs

1. On a new tab, pick **AI** under the search box (⌘/Ctrl+K opens a new tab with AI picked), then type a question and press **Enter**, or click the **mic** and speak. Example questions show below the box. The choice is remembered for the next new tab. While you type, the box suggests pages from your history. DuckDuckGo's search suggestions are off by default, because they send what you type; switch them on in **Settings → Privacy**. An address (like `example.com`) always opens as a web page.
2. **AI result** reads the top results and streams an answer with `[1]`-style citations.
   - **Ask a follow-up** under the answer: it reuses the same sources and the earlier questions and answers. If the sources don't cover it, a **Search the web for this** button runs it as a new search in the tab. Follow-ups are not restored after a restart.
   - **Style chips** (single-select) pick how it's written: **Quick answer** (6 sources), **Detailed** (10 sources: sections, steps for how-to questions, facts and numbers, where sources agree or differ) and **Compare** (8 sources, with a table). One result is shown at a time. Switching to a style already generated for this search shows it instantly; otherwise it is generated then.
   - **Settings → Search → Default result style** (a dropdown) sets the preselected chip. New styles are added in `src/shared/searchModes.ts`.
   - Next to the chips: **Regenerate**, tokens/sec and **Copy**.
   - **Settings → Search → Sources to read**: Automatic (each style's own number) or 3 / 5 / 8 / 10 for every style. Changing it regenerates the shown answer.
   - **Grounding:** the model is told to use only facts from the sources, cite every fact, and write "The sources don't say" instead of guessing. Optional sections are left out when the sources don't cover them, and the temperature is 0.2. Each source contributes its opening paragraph plus the paragraphs matching the query (up to 800 tokens). A citation to a source number that doesn't exist is shown as plain text with a note: "Some citations didn't match a source."
   - The **Sources** list links to the pages, which open in a new tab.
   - **Images** under the sources show the preview pictures those pages declare (`og:image`). **More images** opens DuckDuckGo Images for the question in a new tab.
   - Source pages are downloaded once per search and shared by every style and the images. The prompt puts the sources before the style instructions, so a second style reuses the already-read sources (prefix cache) and starts faster.
3. **Results** lists the web results. **Images**, **Videos**, **News** and **Maps** (on the right of the header) open DuckDuckGo's or OpenStreetMap's page for the question in a new browser tab.
4. **The tab:** an AI tab is titled with its question and marked with a sparkle. You can have several, each with its own answer, and they're closed, reordered and restored like any tab. Sources, results and images always open in new browser tabs, so the answer stays where it was.
   - The address bar shows the question. Typing a new question there replaces the answer in the same tab; typing an address turns the tab into a normal web page.
   - ⌘/Ctrl+R runs the search again. AI tabs have no side panel.

Results come from DuckDuckGo, loaded in a hidden browser view like a normal search. The answer is written by your local model.

### Speech to text

- Click the mic, speak, then click again.
- The audio is resampled to 16 kHz in the app and transcribed by Whisper in its own process. The model starts loading as soon as you start talking.
- Mic buttons are in the address bar, the Search box and Chat.
- **Settings → Voice input language** sets the language Whisper listens for (default: auto-detect). It's separate from the summary language.
- On first use, macOS asks for microphone access.

### Ad blocking

On by default. You can switch it off in **Settings → Privacy**.

- Requests to ad and tracker hosts are blocked, and leftover ad slots are hidden.
- The lists ship in `resources/filters`: EasyList, EasyPrivacy, Peter Lowe's list and uBlock Origin's lists, plus uBlock's scriptlets. The scriptlets remove ads that a site serves itself, such as YouTube video ads, which domain blocking can't catch.
- `npm run update-filters` refreshes the lists before a release; the app never downloads them itself. YouTube changes its ad delivery often, so refresh before each release.

## Architecture

```
┌──────────────────────────────── Electron main process (Node) ────────────────────────────────┐
│  index.ts     lifecycle, window, menu/shortcuts, wiring, dev flags                             │
│  tabs.ts      TabManager → one sandboxed WebContentsView per tab (persist:browsing session)    │
│  extract.ts   isolated-world capture → Readability → Turndown → boilerplate strip (+ PDF.js)    │
│  summarize.ts chunking (model tokenizer) → single pass or map-reduce; styles; caching           │
│  retrieval.ts chunk embeddings in SQLite + cosine top-k (chat on long pages)                   │
│  assistant.ts summary / chat / search-answer orchestration and streaming                       │
│  search.ts + webSearch.ts   SearchProvider (DuckDuckGo in a hidden view) · source reading       │
│  adblock.ts   Ghostery engine · EasyList, EasyPrivacy, uBlock lists + scriptlets               │
│  speech/service.ts          speech-to-text client (talks to speech/worker.ts)                  │
│  db.ts        better-sqlite3: settings, history, summaries, embeddings                        │
│  ipc.ts       zod-validated, sender-checked invoke handlers                                    │
│  llm/         provider.ts · llamacpp.ts · mock.ts · models.ts · hardware.ts                    │
└──────┬──────────────────────────────┬──────────────────────────────┬──────────────────────────┘
       │ typed messages               │ typed messages               │ ipcRenderer.invoke / events
┌──────▼────────────────────┐ ┌───────▼─────────────────────┐ ┌──────▼────────────────────────────┐
│ utilityProcess: LLM       │ │ utilityProcess: speech       │ │ preload (contextIsolation, sandbox)│
│ llm/worker.ts             │ │ speech/worker.ts             │ │  window.api: allow-listed channels │
│ node-llama-cpp · Metal/   │ │ whisper.cpp (@fugood) ·      │ ├────────────────────────────────────┤
│ CUDA/Vulkan/CPU · JSON    │ │ Metal/CUDA/Vulkan · warm-up  │ │ renderer (React): tabs, address    │
│ grammar · idle unload ·   │ │ on record · idle unload      │ │ bar, web and AI tabs, side         │
│ reused KV sequence        │ │                              │ │ panel, dropdowns, mic, settings    │
└───────────────────────────┘ └──────────────────────────────┘ └────────────────────────────────────┘
        Web pages: WebContentsView × N, sandboxed, contextIsolation, no Node, ad blocking
```

- **Streaming.** The worker emits text chunks. The main process forwards them as `stream` events with a stream id, and **Stop** aborts the request in the worker.
- **Prefix cache.** Each loaded model keeps one context sequence that is reused across requests, so a repeated system prompt isn't re-processed. Hybrid and recurrent models start from a clean sequence each time instead.
- **Extensibility:**
  - New Images/Videos-style links: `src/shared/verticals.ts`. New answer styles: `src/shared/searchModes.ts`.
  - New search engines: the `SearchProvider` interface.
  - New LLM backends: `LLMProvider`.

## Security

- **Sandboxing.** Web content runs in sandboxed `WebContentsView`s with `contextIsolation`, no Node, and no preload from the app.
- **UI renderer.** It is sandboxed too. Its CSP is `script-src 'self'`, and production builds drop the dev-server `localhost` entries. Its `will-navigate` and `window.open` are denied, and `<webview>` is blocked.
- **IPC.**
  - A typed preload with channel allow-lists.
  - Every payload is validated with zod, and the sender must be the app's own UI frame.
  - Audio payloads are size-capped at 2 minutes.
- **Permissions.** Web pages get camera, mic, location or notification access only after you allow it in the prompt strip, and the answer is stored per site. The app's own window may use the microphone, audio only, for dictation; web pages can't use the app's mic permission.
- **Source fetches.** Search reads source pages from a separate in-memory session that never sends cookies, so your logins don't travel with them.
- **Packaged builds.**
  - `--screenshots` and the `AB_*` environment variables are ignored. `--self-test` stays available for checking an installed app.
  - Electron fuses (`electron-builder.yml`): `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` are disabled; cookies are encrypted on disk; the app loads only from its asar archive, with integrity checking.
- **Network.**
  - The app connects to the pages you visit, to DuckDuckGo (and OpenStreetMap) for AI tabs and, only if you switch them on, for search suggestions as you type on a new tab (sent without cookies), and to Hugging Face for model downloads you start.
  - There is no telemetry.
  - Ad-block lists, llama.cpp and whisper.cpp binaries ship with the app.
  - Spellcheck is macOS-only, so no dictionaries are downloaded.

## Developer tools

| Command                                                       | What it does                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `npm run typecheck && npm run lint`                           | Strict TypeScript and ESLint                                            |
| `npx electron out/main/index.js --self-test=/path/model.gguf` | Checks the inference stack: backend, streaming, grammar JSON, tokenizer |
| `npx electron out/main/index.js --screenshots=<dir>`          | Walks through the main UI states and saves PNGs (dev builds only)       |
| `AB_MODEL_PATH=<gguf>`                                        | Uses this GGUF for all text roles (scripted runs, dev builds only)      |
| `AB_USER_DATA=<dir>`                                          | Uses a separate profile directory (dev builds only)                     |
| `npm run update-filters`                                      | Refreshes the bundled ad-block lists                                    |

## Build & package

```bash
npm run build            # typecheck + bundle (out/)
npm run package          # installers for the current OS → dist/
npm run package:mac      # .dmg   (also :win → NSIS .exe, :linux → AppImage + .deb)
```

- `electron-builder.yml` unpacks `node-llama-cpp`, `@node-llama-cpp/*`, `@fugood/*` (whisper.cpp) and `better-sqlite3` from the asar archive. It also ships `resources/filters` as `extraResources`.
- Build each OS's installer on that OS, so the matching native prebuilds are included.
- The macOS entitlements include microphone input.
- Local unsigned builds: `CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac`.

## Troubleshooting

| Problem                                | Fix                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Electron failed to install correctly` | Run `node node_modules/electron/install.js`.                                                              |
| "No local model yet"                   | **Settings → Models**: download or import a model and assign it to a role.                                |
| "No speech model installed"            | **Settings → Models → Speech to text**: download Whisper.                                                 |
| Mic does nothing / access is off       | macOS: **System Settings → Privacy & Security → Microphone**, allow Agentic Browser (or Electron in dev). |
| "Not enough memory"                    | Use **Use smaller context**, or pick a smaller model. Close other heavy apps.                             |
| "Model file is damaged"                | **Settings → Models → Delete**, then download again.                                                      |
| "The local model stopped"              | The worker crashed (often out of memory). It restarts on the next request.                                |
| Slow generation                        | If the footer says **CPU**, update GPU drivers or set GPU acceleration to Automatic.                      |
| Search shows "No results found"        | DuckDuckGo didn't load. Check the connection and try again.                                               |
| A site looks broken                    | Try turning off ad blocking in **Settings → Privacy**.                                                    |

## License & attribution

- The app code is MIT.
- **Built with Llama.** Llama 3.2 and Llama 3.1 are licensed under the Llama Community License, Copyright © Meta Platforms, Inc. Models are downloaded by the user after accepting the license, and are not redistributed with the app.
- Qwen3 models are Apache-2.0 (Alibaba Cloud). Whisper models are MIT (OpenAI), in whisper.cpp's GGML format. nomic-embed-text is Apache-2.0.
- EasyList and EasyPrivacy are dual-licensed GPLv3 / CC BY-SA 3.0. uBlock Origin's filter lists and resources are GPLv3. Peter Lowe's list is free for this use. The Ghostery adblocker is MPL-2.0.
