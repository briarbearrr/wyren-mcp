# Workflow Patterns & Best Practices

## Golden rules

1. **`build_graph` is the ONLY graph mutation tool.** It supports `addNodes`, `addEdges`, `dataUpdates` (partial merge), `removeNodeIds`, and `removeEdgeIds` — all atomic in one call. Auto-positions new nodes in a clean DAG layout. The old single-node tools (`add_node`, `remove_node`, `update_node_data`, `connect_nodes`, `disconnect_nodes`, `list_edges`) have been removed.
2. **ALWAYS enrich prompts** — never connect `textInput` directly to `imageAI` or `videoAI`. Route through `textAI` with a prompt template first. This is the single biggest quality improvement.
3. **Image first, then video** — video generation is slow (1–4 min) and expensive. Generate an image first, iterate until it looks right, then use it as a start frame for video. Don't skip straight to video.
4. **One Text AI per purpose** — when a workflow needs both a video prompt AND a narration script, use TWO separate `textAI` nodes. Each feeds ONLY its downstream node. Never connect narration to video or vice versa.
5. **Reuse before building** — always `list_workflows` first, even when the user says "build me X". If a workflow with a similar structure exists, `duplicate_workflow` and modify it — faster than building from zero. After duplicating, always update the input nodes with new content before running — the old inputs are still baked in.
6. **voiceAI never connects to videoAI** — video generation doesn't accept audio. To combine voice with video, both feed into `videoCaptions`.

## Connection logic

Each node type has a specific role. Connect them based on what data flows where:

| Source node             | Output                   | Connects to       | Target handle | Why                                                                                                                   |
| ----------------------- | ------------------------ | ----------------- | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `textInput`             | `text`                   | `textAI`          | `text`        | Raw input → prompt enrichment                                                                                         |
| `textInput`             | `text`                   | `websiteResearch` | —             | websiteResearch has no inputs; URL is configured via data                                                             |
| `textAI` (video prompt) | `text`                   | `videoAI`         | `text`        | Enriched prompt → video generation                                                                                    |
| `textAI` (image prompt) | `text`                   | `imageAI`         | `text`        | Enriched prompt → image generation                                                                                    |
| `textAI` (narration)    | `text`                   | `voiceAI`         | `text`        | Script → voice synthesis                                                                                              |
| `imageAI`               | `image`                  | `videoAI`         | `startFrame`  | Start frame → video (much better results). **Not all models/modes accept this** — check with `get_model_capabilities` |
| `videoAI`               | `video`                  | `videoCaptions`   | `video`       | Video → add captions                                                                                                  |
| `voiceAI`               | `audio`                  | `videoCaptions`   | `audio`       | Voiceover → burn into captioned video                                                                                 |
| `websiteResearch`       | `brandDocument`          | `textAI`          | `text`        | Brand context → prompt enrichment                                                                                     |
| `websiteResearch`       | `colorPalette`           | `textAI`          | `text`        | Color info → style-aware prompts                                                                                      |
| `websiteResearch`       | `screenshots`            | `imageAI`         | `image`       | Website visual → reference image                                                                                      |
| `storyAI`               | `scene_1`–`scene_5`      | `imageAI`         | `text`        | Scene prompt → image per scene                                                                                        |
| `imageAI` #1            | `image`                  | `imageAI` #2      | `image`       | Reference chain for character consistency                                                                             |
| `videoAI`               | `firstFrame`/`lastFrame` | `videoAI` (next)  | `startFrame`  | Scene continuity across clips                                                                                         |
| `audioInput`            | `audio`                  | `audioAnalyze`    | `audio`       | Music bed → BPM + beat detection                                                                                      |
| `audioInput`            | `audio`                  | `audioOverlay`    | `audio`       | Music bed → mix or replace audio on a video                                                                           |
| `audioInput`            | `audio`                  | `slideshow`       | `audio`       | Music bed → slideshow soundtrack                                                                                      |
| `audioAnalyze`          | `beats`                  | `videoMerge`      | `beats`       | Beat grid → set `beatSyncEnabled` + `beatsPerClip` to retime clips to bar boundaries                                  |
| `audioAnalyze`          | `beats`                  | `slideshow`       | `beats`       | Beat grid → set `beatSyncEnabled` for bar-aligned image durations                                                     |

**Anti-patterns** (never do these):

- `textInput` → `videoAI` (no prompt enrichment — bad results)
- `textAI` (narration) → `videoAI` (narration text is not a video prompt)
- `voiceAI` → `videoAI` (audio doesn't connect to video generation)
- `textInput` → `voiceAI` (raw text sounds unnatural — enrich first)
- `imageInput` → `videoAI` (startFrame) without asking — the raw photo becomes the literal first frame. Ask the user if they want the exact image as frame 1, or a styled scene. Default to routing through `imageAI` for product/marketing use cases.

## Pattern: Simple text-to-video

```
textInput → textAI (video prompt) → imageAI → videoAI
```

The `imageAI` generates a start frame. This gives the video model a clear visual anchor and produces much better results than text-only input.

```
build_graph({
  workflowId: "...",
  addNodes: [
    { tempId: "t1", type: "textInput", data: { text: "A cat playing piano" } },
    { tempId: "t2", type: "textAI", data: { promptTemplate: "video" } },
    { tempId: "t3", type: "imageAI", data: { promptTemplate: "social-visual" } },
    { tempId: "t4", type: "videoAI", data: { promptTemplate: "short-form" } }
  ],
  addEdges: [
    { sourceNode: "t1", sourceHandle: "text", targetNode: "t2", targetHandle: "text" },
    { sourceNode: "t2", sourceHandle: "text", targetNode: "t3", targetHandle: "text" },
    { sourceNode: "t2", sourceHandle: "text", targetNode: "t4", targetHandle: "text" },
    { sourceNode: "t3", sourceHandle: "image", targetNode: "t4", targetHandle: "startFrame" }
  ]
})
```

Note: `textAI` feeds BOTH `imageAI` (for the start frame) AND `videoAI` (for the video prompt). The image also feeds into videoAI as the start frame.

## Pattern: Video with voiceover + captions

Two separate `textAI` nodes — one for visuals, one for narration. They never cross-connect.

```
textInput ──→ textAI #1 (video prompt) ──→ imageAI ──→ videoAI ──→ videoCaptions
    │                                                                    ↑
    └────→ textAI #2 (narration) ──→ voiceAI ────────────────────────────┘
```

```
build_graph({
  workflowId: "...",
  addNodes: [
    { tempId: "input", type: "textInput", data: { text: "..." } },
    { tempId: "vidPrompt", type: "textAI", data: { promptTemplate: "video" } },
    { tempId: "narration", type: "textAI", data: { promptTemplate: "narration" } },
    { tempId: "img", type: "imageAI", data: { promptTemplate: "social-visual" } },
    { tempId: "video", type: "videoAI", data: { aspectRatio: "9:16", promptTemplate: "short-form" } },
    { tempId: "voice", type: "voiceAI", data: { presetVoiceId: "..." } },
    { tempId: "captions", type: "videoCaptions" }
  ],
  addEdges: [
    { sourceNode: "input", sourceHandle: "text", targetNode: "vidPrompt", targetHandle: "text" },
    { sourceNode: "input", sourceHandle: "text", targetNode: "narration", targetHandle: "text" },
    { sourceNode: "vidPrompt", sourceHandle: "text", targetNode: "img", targetHandle: "text" },
    { sourceNode: "vidPrompt", sourceHandle: "text", targetNode: "video", targetHandle: "text" },
    { sourceNode: "img", sourceHandle: "image", targetNode: "video", targetHandle: "startFrame" },
    { sourceNode: "narration", sourceHandle: "text", targetNode: "voice", targetHandle: "text" },
    { sourceNode: "video", sourceHandle: "video", targetNode: "captions", targetHandle: "video" },
    { sourceNode: "voice", sourceHandle: "audio", targetNode: "captions", targetHandle: "audio" }
  ]
})
```

## Pattern: Product photo → marketing video

When the user provides a product image and wants a marketing video, route the photo through `imageAI` as a reference to generate a styled scene — never use raw product photos directly as videoAI startFrame (the video would literally start with the raw photo).

```
imageInput (product photo) ──image──→ imageAI (generate styled scene) ──→ videoAI (startFrame)
                                         ↑                                    ↑
textInput ──→ textAI #1 (video prompt) ──┘────────────────────────────────────┘
    │                                                                              → videoCaptions
    └────→ textAI #2 (narration) ──→ voiceAI ──────────────────────────────────────→     ↑
                                                                              videoAI ───┘
```

```
build_graph({
  workflowId: "...",
  addNodes: [
    { tempId: "input", type: "textInput", data: { text: "..." } },
    { tempId: "photo", type: "imageInput", data: { url: "https://..." } },
    { tempId: "vidPrompt", type: "textAI", data: { promptTemplate: "video" } },
    { tempId: "narration", type: "textAI", data: { promptTemplate: "narration" } },
    { tempId: "img", type: "imageAI", data: { aspectRatio: "9:16", promptTemplate: "social-visual" } },
    { tempId: "video", type: "videoAI", data: { aspectRatio: "9:16", promptTemplate: "marketing-ad" } },
    { tempId: "voice", type: "voiceAI", data: { presetVoiceId: "..." } },
    { tempId: "captions", type: "videoCaptions" }
  ],
  addEdges: [
    { sourceNode: "input", sourceHandle: "text", targetNode: "vidPrompt", targetHandle: "text" },
    { sourceNode: "input", sourceHandle: "text", targetNode: "narration", targetHandle: "text" },
    { sourceNode: "vidPrompt", sourceHandle: "text", targetNode: "img", targetHandle: "text" },
    { sourceNode: "vidPrompt", sourceHandle: "text", targetNode: "video", targetHandle: "text" },
    { sourceNode: "photo", sourceHandle: "image", targetNode: "img", targetHandle: "image" },
    { sourceNode: "img", sourceHandle: "image", targetNode: "video", targetHandle: "startFrame" },
    { sourceNode: "narration", sourceHandle: "text", targetNode: "voice", targetHandle: "text" },
    { sourceNode: "video", sourceHandle: "video", targetNode: "captions", targetHandle: "video" },
    { sourceNode: "voice", sourceHandle: "audio", targetNode: "captions", targetHandle: "audio" }
  ]
})
```

## Pattern: Brand analysis → marketing video

Use `websiteResearch` to extract brand context, then feed it into prompt generation.

```
websiteResearch ──brandDocument──→ textAI #1 (video prompt) ──→ imageAI ──→ videoAI ──→ videoCaptions
       │                                                                                      ↑
       └──brandDocument──→ textAI #2 (narration) ──→ voiceAI ────────────────────────────────┘
```

`websiteResearch` has NO input sockets — the URL is configured via `build_graph` with a `dataUpdates` entry (e.g. `dataUpdates: [{ nodeId: "...", data: { url: "https://..." } }]`). It outputs `brandDocument` (text analysis), `colorPalette` (colors), and `screenshots` (images).

**Provider selection**: `websiteResearch` has a `provider` field (default `firecrawl`). Set `provider: "standard"` when the user wants to avoid spending Firecrawl credits — it uses free fetch+cheerio, works on server-rendered marketing sites, but skips screenshots. If the workflow downstream uses the `screenshots` output, stay on `firecrawl`. If Firecrawl credits are exhausted, the node returns an actionable error telling the user to switch providers.

### Retrofitting brand context into an essential

Essentials (`use_essential`) ship with a fixed graph that does NOT include `websiteResearch`. When the user has given a URL, you must inject it after copying the essential:

1. `use_essential({ essentialId })` → returns `workflow_id`.
2. `get_workflow({ workflowId })` → identify the `textAI` (and `imageAI` if present) node IDs and their text/image input handle IDs.
3. `build_graph` with one atomic call adding the research node AND edges:
   ```
   build_graph({
     workflowId,
     addNodes: [
       { tempId: "research", type: "websiteResearch", data: { url: "<user URL>", provider: "firecrawl" } }
     ],
     addEdges: [
       { source: "research", sourceHandle: "brandDocument", target: "<textAI id>", targetHandle: "<text input handle>" },
       // If the essential has imageAI and you want visual grounding:
       { source: "research", sourceHandle: "screenshots", target: "<imageAI id>", targetHandle: "<image input handle>" }
     ]
   })
   ```
4. Update the `textAI` prompt via `dataUpdates` to reference the brand document explicitly (e.g. "Using the brand document from the connected input, write a 15-word voiceover for …"). Do NOT hardcode facts the brand document will supply.
5. `validate_workflow`, then run.

Do NOT skip this step even if the essential "already works" — without `websiteResearch`, the output will be generic and the user will reject it. This is the single most common cause of "the video has no mention of my company" complaints.

## Pattern: TikTok 3-scene branded ad (default for any branded short-form request)

This is the **default** topology when the user asks for a branded ad / TikTok / Reel / short-form marketing video AND has provided a URL. Deviate only on explicit user rejection or when `get_pricing({ chain: [...] })` shows the rich default physically cannot fit the budget.

```
websiteResearch ─brandDocument─┐
imageInput (user logo/photo) ──┤
                               ├─→ textAI (3-scene concept)
                               │        │
                               │        ├─→ textAI #vid1 → imageAI #1 → videoAI #1 ──┐
                               │        ├─→ textAI #vid2 → imageAI #2 → videoAI #2 ──┤
                               │        └─→ textAI #vid3 → imageAI #3 → videoAI #3 ──┤
                               │                                                     ↓
                               └─→ textAI #narration → voiceAI              videoMerge
                                                         │                    (videos)
                                                         ↓                       │
                                                    videoCaptions ←──────────────┘
```

**Key wiring rules:**

- `imageInput` feeds each `imageAI` as a reference image (brand anchor) — never directly to `videoAI` as a raw start frame.
- The "3-scene concept" `textAI` node receives both `websiteResearch.brandDocument` and the user's original `textInput` so the concept is specific to the brand.
- Each scene's video-prompt `textAI` is seeded with ONE scene of the concept — use three separate `textAI` nodes (per the "One Text AI per purpose" golden rule), not one multi-output template.
- **`videoMerge` has ONE input handle named `videos` that accepts up to 10 connections.** Every `videoAI.video` → `videoMerge.videos` edge targets the same `videos` handle. **Never** write `video1` / `video2` / `video3` as target handles — that's the single most common graph-building mistake.
- `voiceAI` and `videoCaptions` are included **by default**. Strip only on explicit user rejection.

**Narration budget for merged outputs** — set the narration `textAI.maxOutputChars` against the **merged** duration (3×5s = 15s → ~225 chars at ~15 chars/sec), not a single scene. The `narration_length_mismatch` validator walks through `videoMerge` to compute the correct budget; if you see a stale single-scene warning, the validator couldn't trace the path — double-check the `voiceAI → videoCaptions.audio` and `videoMerge → videoCaptions.video` edges are both present.

**Budget stripping priority** — if `get_pricing` shows overflow, drop nodes in this order until it fits: (1) 3 scenes → 1 scene (one `imageAI` + one `videoAI`, skip `videoMerge`), (2) `voiceAI` → none, (3) `videoCaptions` → none. Never strip `imageInput` or `websiteResearch`.

## Pattern: Human-in-the-loop gate before expensive steps

Insert a `gate` between a cheap upstream generator and an expensive downstream consumer so the user picks a winning candidate before credits are committed. The canonical placement is `imageAI → gate → videoAI` — image runs are cheap, the user iterates until one looks right, pins it in the gate, and only then does `videoAI` fire on the chosen frame.

```
textAI (image prompt) → imageAI → gate → videoAI → videoCaptions
```

```
build_graph({
  workflowId: "...",
  addNodes: [
    { tempId: "img", type: "imageAI", data: { promptTemplate: "social-visual", aspectRatio: "9:16" } },
    { tempId: "pick", type: "gate", data: {
        productLabel: "Pick your hero frame",
        productName: "hero-frame",
        maxCandidates: "accumulate"
    } },
    { tempId: "vid", type: "videoAI", data: { promptTemplate: "marketing-ad", aspectRatio: "9:16" } }
  ],
  addEdges: [
    { sourceNode: "img",  sourceHandle: "image",  targetNode: "pick", targetHandle: "input" },
    { sourceNode: "pick", sourceHandle: "output", targetNode: "vid",  targetHandle: "startFrame" }
  ]
})
```

**Rules:**

- Gate has a single `any` input (max 1 connection) and a single `any` output — it passes the **selected** candidate through, not the latest run. The socket type is inferred from the incoming edge, so the same gate type works for `image`, `video`, `audio`, or `text`.
- `maxCandidates: "accumulate"` (default) keeps every upstream run in the candidate gallery. Set to `1` only when the user explicitly wants each new run to replace the previous one.
- Set `productLabel` + `productName` on every gate you intend to publish — without them, custom product pages can't address the gate via `<ProductGate name="..." />` and the default page falls back to a generic "Gate" label.
- In published API runs, gates are resolved by `gate_config` (see [products.md](products.md)) — `auto_approve` passes the most recent upstream output through without human intervention, `skip` behaves the same with a softer semantic, `fail` hard-blocks API execution. Design gates so `auto_approve` produces a usable pipeline when the caller is an API, not a human.

**When to insert one:**

- Before any `videoAI` that the user wants to "get right" — image-to-video runs are the single most expensive step in most pipelines.
- Before a `slideshow` / `videoMerge` when you've generated more candidates than slots (e.g., 5 `imageAI` runs, pick 3).
- After a `storyAI` scene breakdown when the user wants to approve the scene concept before committing to per-scene image/video generation.
- As a review point between `voiceAI` and `videoCaptions` when tone matters.

**When NOT to insert one:**

- Don't use gates to "toggle branches on/off" — that's not what they do. Gates are selectors, not switches. If you want conditional execution, omit the branch entirely or build a separate workflow variant.
- Don't stack a gate in front of every node — each gate is a hard pause that blocks downstream execution until the user picks. Use them only at genuine decision points.

## Pattern: Multi-scene video (storyAI)

For longer content with multiple scenes, use `storyAI` to generate per-scene prompts. Chain image references for character consistency.

```
textInput → storyAI ──scene_1──→ imageAI #1 → videoAI #1
                  │                ↓ (image reference)
                  ├──scene_2──→ imageAI #2 → videoAI #2
                  │                ↓ (image reference)
                  └──scene_3──→ imageAI #3 → videoAI #3
```

Each `imageAI` connects its `image` output to the next `imageAI`'s `image` input as a reference. This keeps characters and style consistent across scenes. Without this chaining, each scene generates completely different-looking visuals.

After all videos are generated, use `videoMerge` to combine them, or `slideshow` for image-based sequences.

## Pattern: TikTok research → inspired content

Use `tiktokResearch` to analyze a trending video, then create content inspired by it.

- `tiktokResearch` outputs: `content` (analysis text), `hook` (hook text), `frame` (start frame image), `clip` (video clip)
- Connect `content` → `textAI` for context-aware prompt generation
- Connect `clip` → `videoAI` as a video reference (model must support it)
- Connect `frame` → `imageAI` as a reference image

## Pattern: Beat-synced video / slideshow

For music-driven video edits where cuts should land on the beat:

```
audioInput → audioAnalyze ─┐
                            ├─→ videoMerge   (beat-aligned cuts)
videoInput #1 ─→ ─────────┘     beatSyncEnabled: true, beatsPerClip: 2
videoInput #2 ─→ ─────────┘
videoInput #3 ─→ ─────────┘
```

Or for an image slideshow that drops on bars:

```
audioInput → audioAnalyze ─┐
                            ├─→ slideshow   (bar-aligned image durations)
imageAI #1..N ─→ ──────────┘    beatSyncEnabled: true, beatsPerImage: 2
```

Notes:

- `audioAnalyze` is **non-billable**. Globally cached on `(sourceUrl, tempoHint, windowSeconds)`, so subsequent runs against the same track are instant.
- `audioAnalyze` outputs a `beats` socket (separate from `audio`) — connect that to the `beats` input on videoMerge or slideshow, not the `audio` input.
- Default `beatsPerClip` / `beatsPerImage` is 2 (i.e. one bar per item under 4/4).
- `speedTolerance` (default 0.15) controls whether a clip retimes via setpts/atempo (within ±15%) or hard-trims to the nearest beat. Set lower to favor hard cuts, higher to favor speed-matching.
- Same `audioInput` can feed both `slideshow` (audio bed) and `audioAnalyze` (beat detection) — wire one output to two consumers.
- For raw music drops over an existing video without beat alignment, use `audioOverlay` (Audio Mix) instead — it has `loop`, `volume`, `fadeInSec`, `fadeOutSec`, and `startOffset` for polish.

## Pattern: Style-consistent content

Add a `globalStyle` node — it broadcasts style to all AI nodes automatically via the system. No edge connections needed. Set its `style` field to a template slug from `list_style_templates`.

## Pattern: Batch content with iterator

When the user wants to generate multiple pieces of content from a list (e.g., "make 5 product videos for these 5 products"), use `iterator` + `closeIterator` instead of duplicating the same nodes multiple times. Iterator splits an array into individual items, runs the loop body per item, and closeIterator collects the results. The workflow stays clean and handles 3 items or 30 items with the same graph.

```
textInput (JSON array) → iterator → textAI → imageAI → videoAI → closeIterator
```

## Build process

1. `list_workflows` — check for existing workflows to duplicate
2. `create_workflow` — new empty workflow
3. `build_graph` — add ALL nodes and edges in one call (the only graph mutation tool)
4. `set_product_inputs` — mark input nodes (textInput, imageInput, videoInput) as `product_inputs` and the final output node (e.g., videoCaptions, videoAI, imageAI) as `product_outputs`. This makes the workflow ready for `run_workflow` with `userInputs` and for publishing as a product API.
5. `validate_workflow` — check for issues
6. Share the workflow URL with the user

## Execution strategy

- **Iterating**: Use `run_node` one at a time. Review image results before generating video. Regenerate individual nodes as needed.
- **Production run**: Use `run_workflow` with `userInputs` for the full pipeline.
- **Cost check**: Call `get_credit_balance` before video generation. Video is expensive — inform the user.

## Validation checklist

Before telling the user a workflow is ready:

0. **Custom prompt shape** — for every AI node (`textAI`, `imageAI`, `videoAI`, `storyAI`) that uses a custom prompt, set **both** `promptTemplate: "custom"` AND `customPrompt: "..."`. The MCP server now auto-coerces a plain `prompt` field to this pair (so `data: { prompt: "..." }` works), but prefer the explicit form in new code — it's clearer and future-proof.
1. `validate_workflow` — fix any reported `issues` (hard errors).
2. **Surface all `warnings` to the user as one consolidated question** before proceeding to execution. Warnings include:
   - `default_prompt_template` — an AI node is using its seeded default prompt template; you haven't customized it for this workflow.
   - `default_model` — an AI node is on its seeded default model; you didn't pick one.
   - `missing_aspect_ratio` — an `imageAI` / `videoAI` node has no `aspectRatio`.
   - `empty_input` — a `textInput` / `imageInput` / `videoInput` has no content.

   If `warnings.length > 0`, do NOT run the workflow. Ask the user: "I left [list] at defaults — want me to customize them to your brand before we run?" Only proceed once the user answers.
3. All AI nodes have models set.
4. All required inputs are connected.
5. Input nodes have content or are clearly for user input at run time.
6. No narration/script Text AI connected to Video AI (common mistake).
7. Text AI nodes feeding downstream AI have `maxOutputChars` set within the downstream model's prompt limit (Imagen 4 = 1400, Kling/Veo = 9500, voice = 4500).
8. `set_product_inputs` was called — input nodes marked as product inputs, final output node marked as product output.
