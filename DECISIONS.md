# Design decisions

Short notes on the trade-offs behind the architecture. See `README.md` for setup and usage.

## 1. Electron, not Tauri

The app reads pages the same way on every OS (isolated-world extraction, SPA settling, PDF handling), and a future agent mode would need to drive them through one protocol. Electron ships one pinned Chromium, and `webContents.debugger` exposes the full Chrome DevTools Protocol for every tab. Each tab is a sandboxed `WebContentsView`, so web content never shares a process or a preload with the browser UI.

Tauri renders through the OS webview: WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux. These are three engines with different feature sets and no common automation protocol. Only WebView2 offers CDP. Page extraction, automation and even layout would differ by platform.

**Cost:** a larger installer (~100 MB more) and higher baseline memory. We accept this. The local model already needs gigabytes of RAM, so the browser runtime is not what limits the hardware we can support.

## 2. Embedded llama.cpp (node-llama-cpp), not Ollama

**Why:**

- **Zero-install UX.** The user installs one app, picks a model, and it works. There is no second daemon to install, update, start, or debug.
- **Grammar-constrained decoding in-process.** `createGrammarForJsonSchema` (`src/main/llm/worker.ts`) constrains sampling to a JSON schema whenever structured output is needed. See section 3.
- **No local server to secure.** There is no localhost HTTP port that other processes (or web pages via DNS rebinding) could call. Inference is reachable only over the main ↔ utility-process message channel.
- **Privacy by construction.** The app makes no network calls for inference. The only model-related traffic is the user-initiated Hugging Face download, which is SHA256-verified.

**Trade-off:** the app now owns work an external runtime would otherwise do:

- **Model downloads.** Resumable HTTP range requests, disk-space checks, checksums, and license acceptance (`models.ts`).
- **Memory management.** Models load lazily, unload after N idle minutes, and only one large model is resident at a time. The context size is clamped to what fits (`worker.ts`).
- **GPU backend compatibility.** node-llama-cpp ships prebuilt Metal, CUDA, and Vulkan binaries and falls back to CPU. We detect hardware (`hardware.ts`) and offload layers to the GPU automatically, sized to fit the configured context. If the GPU load fails, the model is reloaded on CPU instead of being reported as broken. Only prebuilt binaries are used (`build: 'never'`), so the app never downloads or compiles llama.cpp at runtime. Native binaries must be unpacked from asar (`electron-builder.yml`).

The `LLMProvider` interface (`src/main/llm/provider.ts`) keeps this decision reversible. An Ollama or OpenAI-compatible backend can be added as an optional advanced setting without touching the summarizer, chat, or search answers. `MockProvider` already implements the same interface for tests and model-less development.

## 3. Grammar-constrained JSON for structured output

Small models often get the shape of structured output wrong: missing braces, prose before the JSON, invented keys. The LLM worker can generate under a JSON-schema grammar (`jsonSchema` on a generate request), so the output is always parseable. Callers still validate the meaning with `zod`, since a grammar can't express every rule. The agent mode that relied on this most heavily has been removed (see FUTURE.md). The capability stays in the worker for future structured features. `--self-test` checks it.

## 4. Inference in a `utilityProcess`

All inference runs in a separate Electron `utilityProcess` (`llm/worker.ts`), driven by `LlamaCppProvider` (`llm/llamacpp.ts`) over a typed message protocol (`llm/protocol.ts`).

- **The UI never blocks.** Token generation, tokenization, and embeddings never run on the main or renderer thread. Tokens stream to the renderer over IPC, and Stop sends an abort.
- **Crash containment.** A native crash or out-of-memory kill takes down only the worker. The provider detects the exit, shows a friendly error with recovery actions, and restarts the worker on the next request. It stops retrying after 3 crashes in a minute and suggests a smaller model or context.
- **Clean memory reclamation.** Unloading a model frees VRAM, and killing the worker on restart returns all of its memory to the OS.
- **ESM isolation.** node-llama-cpp is ESM-only and loaded with a real dynamic `import()` inside the worker, kept apart from the CommonJS main bundle.

## Smaller decisions

- **SQLite via better-sqlite3** for history, the summary cache keyed by `(url, content_hash, mode, model)`, embeddings and settings. It is synchronous, fast, and a single file, with no server.
- **Readability → Turndown**, with an `innerText` fallback, for extraction. Markdown keeps headings, so chunking can split on structure, and it costs fewer tokens than HTML.
- **Embeddings retrieval** for chat on long pages uses a small GGUF embedding model and brute-force cosine similarity. At the scale of a single page this is fast enough to need no vector index.
- **Search answers** come from a hidden browser view of DuckDuckGo's normal results page, not its no-JavaScript endpoint, which challenges automated requests. The source pages are fetched from a separate in-memory session that sends no cookies, then summarized locally.
- **Speech to text** uses whisper.cpp in its own utility process, for the same isolation reasons as the LLM. Audio is resampled to 16 kHz in the renderer, so no ffmpeg is needed.
- **Ad blocking** uses Ghostery's engine with lists bundled in the app, so the "no hidden network calls" rule holds: EasyList, EasyPrivacy, Peter Lowe's list, and uBlock Origin's filters (2020–2024 and current), badware, privacy, resource-abuse, quick-fixes and unbreak lists, plus uBlock's `resources.json` for scriptlets. This matches Ghostery's "ads and tracking" preset. `npm run update-filters` refreshes them.
