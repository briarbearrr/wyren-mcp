# Nodes and Connections

## Node categories

### Input nodes (provide data to the pipeline)

| Type         | Label       | Output socket | Purpose                                             |
| ------------ | ----------- | ------------- | --------------------------------------------------- |
| `textInput`  | Text Input  | text          | User-provided text (prompts, descriptions, scripts) |
| `imageInput` | Image Input | image         | User-provided image (reference photos, logos)       |
| `videoInput` | Video Input | video         | User-provided video (source footage)                |
| `audioInput` | Audio Input | audio         | User-provided audio (music beds, voiceover stems, songs) |

### AI nodes (generate content — cost credits)

| Type              | Label            | Input sockets              | Output socket | Execution                                 |
| ----------------- | ---------------- | -------------------------- | ------------- | ----------------------------------------- |
| `textAI`          | Text AI          | text                       | text          | Sync — instant result                     |
| `storyAI`         | Story AI         | text                       | text          | Sync — instant result                     |
| `imageAI`         | Image AI         | text, image (optional ref) | image         | Async — background job, polls until done  |
| `videoAI`         | Video AI         | text, image                | video         | Async — background job (can take minutes) |
| `voiceAI`         | Voice AI         | text                       | audio         | Sync — instant result                     |
| `websiteResearch` | Website Research | text                       | text          | Sync                                      |

### Data nodes (configure and filter)

| Type             | Label           | Purpose                                                   |
| ---------------- | --------------- | --------------------------------------------------------- |
| `globalStyle`    | Global Style    | Applies a visual style template to all connected AI nodes |
| `gate`           | Gate            | Human-in-the-loop candidate selector — accumulates upstream runs, user picks one, downstream sees the pick |
| `trendSelector`  | Trend Selector  | Picks trending topics from the trend database             |
| `tiktokResearch` | TikTok Research | Analyzes TikTok trends and content                        |
| `audioAnalyze`   | Audio Beats     | BPM + beat detection on an audio source. Outputs `tempo`, `beats` (struct), `firstBeat`, `barTimes`. Non-billable. Globally cached. |

### Edit nodes (transform media)

| Type            | Label          | Input                          | Output | Purpose                                                                                                |
| --------------- | -------------- | ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------ |
| `videoTrim`     | Video Cut      | video                          | video  | Trim start/end + optional `playbackSpeed` (0.25–4.0) and `preservePitch`                                |
| `videoMerge`    | Video Merge    | videos (N), beats (optional)   | video  | Combine multiple videos. With Beats input + `beatSyncEnabled`, each clip retimes to bar boundaries     |
| `audioOverlay`  | Audio Mix      | video, audio (or local URLs)   | video  | Replace/mix audio onto a video. Polish: `loop`, `fadeInSec`, `fadeOutSec`, `volume`, `startOffset`     |
| `audioExtract`  | Audio Extract  | video                          | audio  | Extract audio track from a video (AAC or MP3)                                                          |
| `videoCaptions` | Video Captions | video, audio (optional)        | video  | Add captions/subtitles overlay                                                                         |

### Compose nodes (combine media)

| Type        | Label     | Purpose                                       |
| ----------- | --------- | --------------------------------------------- |
| `slideshow` | Slideshow | Combine images + audio into a video slideshow. With Beats input + `beatSyncEnabled`, each image aligns to bar boundaries |

### Flow nodes (control execution)

| Type            | Label          | Purpose                                                |
| --------------- | -------------- | ------------------------------------------------------ |
| `iterator`      | Iterator       | Loop over an array — executes body nodes for each item |
| `closeIterator` | Close Iterator | Collects loop results back into an array               |

## Socket types

There are 6 socket types. Connections are only valid between compatible sockets:

| Socket  | Color      | Compatible with                  |
| ------- | ---------- | -------------------------------- |
| `text`  | Indigo     | text, any                        |
| `image` | Teal       | image, any                       |
| `video` | Amber      | video, any                       |
| `audio` | Purple     | audio, any                       |
| `beats` | Dusty Rose | beats only (audioAnalyze output) |
| `any`   | Gray       | text, image, video, audio        |

**Rule**: You can only connect an output to an input if their socket types are compatible.

## Connection rules

- Each input handle accepts **one** connection by default (some nodes override this via `connectionValidator`)
- Output handles can connect to **multiple** inputs
- No cycles allowed — the graph must be a DAG
- Use `get_node_type_info` to check a node's exact handles and connection limits

## Configuring nodes

Each node has configurable fields set via `build_graph` with `dataUpdates` (partial merge). The server validates all values and returns clear error messages for out-of-range parameters — with the field's full schema in `details.fieldErrors`. Unambiguous scalar type mismatches (e.g., `"off"` for a boolean) are auto-coerced.

Common fields:

- **AI nodes**: `model` (model ID), `promptTemplate` (prompt template slug or "custom"), `customPrompt` (when promptTemplate is "custom"), `style` (style template slug)
- **Text Input**: `text` (the content), `label` (display name)
- **Image Input**: `url` (image URL — auto-normalized to internal format), `label` (display name)
- **Video Input**: `url` (video URL), `label` (display name)
- **Voice AI**: `model`, `presetVoiceId` (voice ID from `list_voices`), `stability`, `similarityBoost`
- **Video AI**: `model`, `mode` (standard/pro), `duration`, `aspectRatio`
- **Website Research**: `url`, `crawlDepth` (1/2/3), `provider` (`firecrawl` = 5 credits, screenshots + JS rendering, `standard` = 3 credits, fetch+cheerio, SSR sites only, no screenshots). Default `firecrawl`. If the user wants to spend fewer credits or the site is static HTML, set `provider: "standard"`.
- **Gate**: `productLabel` (user-facing prompt, e.g. "Pick your hero image"), `productName` (semantic slug for `<ProductGate name="..." />` — required for custom product pages), `maxCandidates` (`"accumulate"` keeps all runs, `1` replaces), `maxRetries` / `maxRetriesUnlimited` (retry cap for product-form runs), `showOnNode` (render candidate gallery inline on canvas). Gate has ONE `any` input + ONE `any` output, max 1 incoming connection; it infers socket type from whatever's plugged in and passes the selected value straight through.

Use `get_node_type_info` for the exact field schema of any node if you need to check constraints before setting values.

## Handle IDs

Both input and output handles use the raw ID from node definitions — no suffixes, no transformations. Use `get_node_type_info({ nodeType: "..." })` to see exact IDs for any node.

**Naming convention**: Multi-input composition nodes use **plural** handle names (`videos`, `images`). Single-input nodes use **singular** names (`video`, `text`, `image`). When unsure, call `get_node_type_info` — handle IDs must be exact.

Common handles:

- `textInput`: output `text`
- `textAI`: output `text`, input `text`
- `storyAI`: outputs `scene_1`–`scene_5`, input `text`
- `imageAI`: output `image`, inputs `text`, `image`
- `videoAI`: output `video`, inputs `text`, `startFrame` (not all models accept startFrame — use `get_model_capabilities` to check)
- `voiceAI`: output `audio`, input `text`
- `websiteResearch`: outputs `brandDocument`, `colorPalette`, `screenshots`
- `videoCaptions`: output `video`, inputs `video`, `audio`
- `videoMerge`: outputs `video`, `duration`; input `videos` (plural — accepts up to 10 connections)
- `videoTrim`: output `video`, input `video`
- `audioInput`: output `audio` (multi-file)
- `audioAnalyze`: outputs `tempo` (text), `beats` (beats struct), `firstBeat` (text), `barTimes` (beats); input `audio`
- `audioOverlay` (Audio Mix): output `video`, `duration`; inputs `video`, `audio` — merges audio onto video (replace or mix mode); polish fields apply only when set
- `audioExtract`: output `audio`; input `video`
- `videoMerge`: outputs `video`, `duration`; inputs `videos` (plural — up to 10), `beats` (optional — pair with `beatSyncEnabled` + `beatsPerClip` to retime clips to bars)
- `videoTrim` (Video Cut): output `video`, input `video`; speed via `playbackSpeed` + `preservePitch`
- `slideshow`: output `video`, inputs `images` (plural), `audio`, `beats` (optional — pair with `beatSyncEnabled` for bar-aligned image durations)
- `iterator`/`closeIterator`: output `items`/`collected`
