# No model named in code

ODM does not write model IDs into its code. The storyteller, utility and
picture pickers list what each provider actually serves (its `/models`,
Ollama's tags, or an agent program's own list), and the model registry
(`src/lib/model-registry`) judges those against [models.dev](https://models.dev),
an open database of AI models: context windows, tool support, prices and
deprecations. When a provider retires a model, the admin sees it marked and
picks another from a list that is always current. Nothing in the code needs
updating.

## The check

`scripts/test-model-catalogs.mjs` runs with `npm test`. It reads the
models.dev snapshot the registry bundles
(`src/lib/model-registry/snapshot.json`) and fails when any string literal in
`src/` is a model ID that snapshot lists, unless one of two lists in
`scripts/lib/model-catalog.mjs` covers it:

- **`RUN_HERE`**: models ODM downloads and runs itself (the embedding model,
  the built-in Whisper, the ComfyUI files). They are pinned like a dependency
  and are not retired under it. None of them is on models.dev today.
- **`PENDING`**: IDs still in `src/` that a follow-up is taking out: the
  OpenAI image default `gpt-image-1` (deprecated) and Grok Build's
  `grok-4.6` fallback. The test also fails once an entry is no longer in
  `src/`, so the list empties as that work lands.

Each entry says why it may stay.

## What it does not catch

- A rule that guesses from a model's name, such as a regular expression for
  which models offer a Fast tier. Those are not string literals.
- A model models.dev does not list. It has few speech models, so `tts-1`,
  `whisper-1`, `gpt-4o-mini-tts` and `gpt-4o-mini-transcribe` pass unseen.
- A name inside a longer string, such as a sentence or a URL.

## Refreshing the snapshot

The registry refreshes its catalog from models.dev once a day at run time and
falls back to the bundled snapshot offline. To update the bundled copy, run
`node scripts/refresh-model-snapshot.mjs`, then `npm test`: a model that
models.dev newly lists under a name `src/` uses fails the check here, in the
same change.
