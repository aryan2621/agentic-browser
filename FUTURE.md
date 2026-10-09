# Not covered yet

What the original spec asked for that isn't in the app yet, or is only partly there, plus follow-ups found while building. [README.md](README.md) describes what works today.

Status key: **Parked** means the code exists but is switched off. **Partial** means it works with gaps. **Missing** means it isn't built.

## 1. Agent mode: Missing (removed)

Spec section D ("Act as an agent", "Research across multiple tabs") was built, then **removed from the code** by product decision: the app focuses on reading tasks for now.

**What the removed version had:**

- The observe → think → act loop over CDP, with 14 tools.
- Grammar-constrained JSON steps with zod validation and retries.
- Loop detection.
- The safety layer: untrusted-content wrapping, confirmations, a downloads gate, a page-initiated navigation guard, and login/CAPTCHA hand-off.
- An audit log, the Agent tab and its settings, and a `--run-task` diagnostic flag.

**Lessons from real-site testing** (Amazon "umbrella between $15 and $25"):

- The agent needs to use the site's own search box, not a web search.
- It needs to read listings with links. Readability drops product grids.
- It needs to wait for follow-up navigations, such as interstitials.
- Qwen3 14B handled the currency mismatch better than the 8B.

**Still to do if it comes back:**

- [ ] Reliable completion on real multi-step tasks, measured on a fixed task set.
- [ ] Observation via the accessibility tree, including iframes and shadow DOM.
- [ ] Per-task domain lists.
- [ ] A token budget for the whole prompt.
- [ ] Stop that interrupts waits immediately.
- [ ] Full Public Suffix List.
- [ ] Live checks of every safety path.

What the current code keeps that an agent could build on:

- **Structured output:** JSON-schema grammar support in the LLM worker (`jsonSchema` on a generate request).
- **Extensible model roles:** the `GenerationRole` type.
- **Search plumbing:** the `SearchProvider` interface.

## 2. Tests: Missing (removed on request)

The spec's non-functional requirements asked for Vitest unit tests and a Playwright (Electron) smoke test. A suite of 78 unit tests and 2 e2e tests existed and passed, but it was removed at the product owner's request to focus on functionality. To restore it:

- [ ] Unit tests: chunking, map-reduce, step validation and retry, safety rules, URL parsing, download resume and checksum.
- [ ] Playwright smoke test: open the app, load a page, summarize with the `MockProvider`.

`npm run typecheck && npm run lint` still run.

## 3. Model layer: Partial

- [ ] **Recovery actions.**
  - "Redownload" only opens Settings; it should delete and re-download.
  - Chat errors have no **Retry** button.
  - The worker restarts on the next request rather than immediately.
- [ ] **Corrupted files stay "ready".** On startup a file is checked by size only. Re-hash in the background, or on a load failure.
- [ ] **License acceptance is enforced only in the UI.** `models:download` doesn't check it, and the app shows a summary and a link instead of the full license text.
- [ ] **Other backends.** OpenAI-compatible and Ollama providers. The spec says "can be added later"; the `LLMProvider` interface is ready for them.
- [ ] **Qwen3.5 models.** They load and generate text, but grammar-constrained JSON breaks with the llama.cpp in node-llama-cpp 3.22.1. Recheck when node-llama-cpp updates.
- [ ] **Hidden "thinking".** It's off (`thoughtTokens: 0`). A small thinking budget could improve accuracy on hard questions, at the cost of speed.
- [ ] **Model choice deviates from the spec.** The spec names Llama 3.2 3B and Llama 3.1 8B. The catalog adds Qwen3 8B because they did better at structured output in testing. On a 16 GB+ machine the recommendation is Qwen3 8B for summaries, chat and search answers. Llama models are still in the catalog.

## 4. AI tabs (search): Partial

- [x] **Simplified (2026-10-09).** Seven answer styles became three (Quick answer, Detailed, Compare; saved Research/Theory/Explain simply/Step by step/Facts & numbers map to Detailed). The sources slider moved to Settings → Search. DuckDuckGo suggestions are off by default. The mock model switch is gone (dev-only `AB_LLM_PROVIDER=mock`).
- [ ] **Images, Videos, News and Maps link out.** They open DuckDuckGo's or OpenStreetMap's page in a new tab (the embedded view was removed to simplify); there are no native galleries.
- [ ] **One results provider (DuckDuckGo).** The `SearchProvider` interface (`src/main/search.ts`) is ready for others, for example a self-hosted SearXNG.
- [ ] **Sources are trimmed to fit.** Each style reads 6–10 results (Settings → Search → Sources to read: Automatic or 3 / 5 / 8 / 10), at most 800 tokens per source (opening paragraph plus query-matching paragraphs). With the default 8K context and many sources the per-source budget shrinks (minimum 250), so details deep in a page can be missed.
- [x] **Follow-up questions** on a search answer (2026-10-09). Still no search history.
- [x] **Ask across tabs (2026-10-09):** side-panel Chat can answer from all or picked open tabs, cited as [n]. "Compare with AI" (tab menu) shows the comparison in the clicked tab's Chat, not in a separate AI tab.
- [ ] **Agent (rebuilt 2026-10-09, simple tasks only):** actor + checker on the local model, `src/main/agent.ts`. Gaps: no iframes or shadow DOM, 80 controls max, no multi-tab tasks, no cloud model option (planned as opt-in).
- [ ] **Answer citations** point to sources, and citations to nonexistent sources are flagged, but individual sentences aren't checked against the cited text.
- [ ] **No search history.** Each AI tab keeps its latest question; there's no back button through earlier questions, and AI questions aren't in History.
- [ ] **No "Ask AI" in the address bar of a web tab.** The Browser / AI choice is on the New Tab page (and ⌘K).
- [ ] **Low-memory hint.** Slow answers are usually swapping (several local models loaded at once). The status bar doesn't yet suggest closing other AI apps.

## 5. Speech to text: Partial

- [ ] **Click to talk only.** Murmur-style hold-to-talk, a global hotkey, and voice activity detection (Silero VAD) aren't wired up.
- [ ] **No mic in the summary custom instruction.** The address bar, Search and Chat have one.
- [ ] **No live partial transcription while speaking.** Text appears when you stop.
- [ ] **Uses an RC-line binding.** `@fugood/whisper.node` 1.1.3 is the newest release allowed by the 7-day npm age policy.
- [ ] **Not packaged or tested** on Windows or Linux.

## 6. Browser shell: Partial

- [ ] **History** is a side-panel tab, not a separate history page.
- [ ] **Ad blocking**
  - Filter lists update only with a new app release (`npm run update-filters`).
  - There's no per-site "allow ads here" switch.
  - Cosmetic filtering relies on Ghostery's preload in every frame.
- [ ] **Spellcheck** is macOS-only. Windows and Linux would download dictionaries from Google.
- [ ] **One window only.** No ⌘N or incognito window.
- [ ] **No bookmarks, extensions or password manager** (out of scope for the MVP).
- [ ] **Sign-in popups** open as their own small windows (so `window.opener` works); not every site's popup flow has been checked.
- [x] Done: last tab quits, session restore, reopen closed tab, find, zoom, print, view source, error and crash pages, external-link and HTTP sign-in prompts, site permission prompts, downloads panel, address-bar suggestions, tab context menu, tab mute.

## 7. Summarization: Partial

- [x] **Simplified (2026-10-09).** Five styles plus Custom became Summary and Detailed, with an optional "Focus on…" field. Old cached summaries under the removed styles are simply never read again.
- [ ] **PDFs:** the text layer only. Scanned PDFs need OCR.
- [ ] **Search sources are HTML only.** PDF results fall back to their snippet.
- [ ] **Page extraction runs JSDOM on the main thread.** Very large pages can briefly stall the UI.
- [ ] **Network idle detection** counts resource-timing entries, which stop at the browser's buffer limit on very heavy pages.

## 8. Platform and packaging: Partial

- [ ] **Only macOS (Apple Silicon) has been run.** Windows and Linux builds, and the CUDA and Vulkan backends, are untested.
- [ ] **macOS signing and notarization** aren't configured. Local builds are unsigned.
- [ ] **Fuses not yet checked on a packaged build.** Verify `ELECTRON_RUN_AS_NODE=1` does nothing and the app still starts with asar integrity on.
- [ ] **No mac architecture list:** builds target the host architecture only. Universal or x64 builds aren't set up.
- [ ] **Packaged app not re-verified** after the latest changes (speech worker, ad blocker, search mode). Run `npm run package:mac` and then `--self-test`.

## 9. Accessibility: Partial

- [ ] **Contrast** hasn't been measured against WCAG.
- [ ] **Keyboard support:** the new Dropdown and composer handle the keyboard, but there has been no full screen-reader pass.

## 10. Browser basics still missing

- [x] **Multiple windows and incognito (2026-10-09).** Gaps: no ad blocking in incognito (Ghostery can't attach to a second session), incognito summaries still use the shared summary cache, only one restored window, tabs can't be dragged between windows.
- [x] **Password manager (2026-10-09).** Gaps: fills the first saved account only (no account picker), no password generator, no import/export, no "show password", sign-ins in iframes aren't captured.
- [x] Bookmarks (2026-10-09). No folders, import or drag-to-reorder yet.
- [x] AI history search (2026-10-09): keyword (FTS5) retrieval, not embeddings.
