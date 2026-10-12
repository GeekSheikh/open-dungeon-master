# Image generation

Inline images are optional — text play works without any image setup. Image
requests made while no backend is available show a Generate button that
succeeds once one is up.

Four backends are exposed in the Images panel:

| Backend | Hardware | Models |
|---|---|---|
| MFLUX Mac | Apple Silicon (MLX) | FLUX.2-klein uncensored |
| SDNQ GPU/CPU | NVIDIA CUDA, supported AMD (ROCm), CPU | FLUX.2-klein |
| ComfyUI | anything ComfyUI runs on | your ComfyUI checkpoints |
| OpenAI | none, the pictures are made off-box | gpt-image-1 and friends |

## The FLUX worker (MFLUX / SDNQ)

Inline images are produced by a small HTTP worker that wraps the optimized
FLUX.2-klein backends from the
[`ultra-fast-image-gen`](https://github.com/newideas99/ultra-fast-image-gen)
project. Apple Silicon uses the resident MFLUX/MLX path; Windows/Linux use
the PyTorch SDNQ path with `IMAGE_SERVER_DEVICE=cuda` or
`IMAGE_SERVER_DEVICE=cpu`. The app expects that repo at
`~/ultra-fast-image-gen` on macOS/Linux or
`%USERPROFILE%\ultra-fast-image-gen` on Windows (override with
`ULTRA_FAST_IMAGE_GEN_DIR`).

The uncensored text encoder is downloaded once from a gated Hugging Face
repo: accept the terms on the model page, then set your token in
`ultra-fast-image-gen`'s web UI (or add `HF_TOKEN=...` to that repo's
`.env`). Windows/Linux use the standard `flux2-4b-sdnq` route by default, so
the gated token is not required for the normal GPU/CPU path.

Start the worker from the **Images** panel with **Start**; the app launches
and supervises the process for you. The **Models** button in the Images panel
opens the local model/cache folder
so you can inspect the patched MFLUX checkout.

CLI routes behind the app's two FLUX backends:

- MFLUX/MLX uncensored HS: `flux2-4b-uncensored-mflux-hs` (Apple Silicon)
- PyTorch SDNQ: `flux2-4b-uncensored-sdnq-hs` on MPS; `flux2-4b-sdnq` on
  CUDA/CPU because the HS attention patch is MPS-only

Defaults are 1024 long-side, 4 steps, guidance 0.0; the slow size is 2048
long-side. Square, portrait, and landscape aspects are exposed in the UI.
Reference images are capped at two per request. MFLUX runs resident by
default on Apple Silicon: the worker keeps the model loaded between
generations. On Windows, the worker automatically maps MFLUX requests to the
SDNQ backend because MLX is not available there.

## ComfyUI

Already run [ComfyUI](https://github.com/comfyanonymous/ComfyUI)? Pick
**ComfyUI** as the Images backend and the app drives your instance directly —
no FLUX worker, no `ultra-fast-image-gen`, and it works on any hardware
ComfyUI supports.

1. Start ComfyUI (default `http://127.0.0.1:8188`).
2. In the Images panel, choose **ComfyUI**, confirm the server URL, and pick
   a checkpoint from the list (or leave it on **Auto** to use the first one).

The app submits a plain text-to-image workflow (positive/negative prompt,
KSampler at 25 steps, CFG 6) and saves the finished PNG alongside the other
generated images. Sizes clamp to a 1024/1344 long side, which suits
SDXL-class checkpoints. Notes:

- Character portrait references are not used by this backend; scenes with
  saved characters generate from the text prompt alone.
- Generations queue behind whatever else your ComfyUI instance is doing.
- Set `COMFYUI_URL` in `.env.local` to change the default server URL.

### Benchmarking image models on your hardware

`src/lib/image-models` catalogues the image models ComfyUI can run for the
app, taken from ComfyUI's own workflow templates (comfyui-workflow-templates
0.11.78, ComfyUI 0.39.2): each model's files and where they download from, and
the graph it runs, with its steps, CFG, sampler, scheduler and shift.
`scripts/bench-image-models.mjs` sends exactly that graph to a running ComfyUI
and measures what a table would wait for:

- the app's own prompts, a character portrait and a creature token (square)
  and a scene (landscape), at the 1024 px fast size;
- seconds per picture once the model is loaded, timed by ComfyUI from the
  start to the end of each job;
- the first picture after a model switch, which also loads the files;
- peak GPU memory, from ComfyUI's own `/system_stats` while the job runs (on a
  unified-memory machine this is the share of system memory the GPU mapped).

```bash
node scripts/bench-image-models.mjs                    # every installed model
node scripts/bench-image-models.mjs --models z_turbo,flux2_klein_4b
node scripts/bench-image-models.mjs --models all --download --comfy-dir ~/ComfyUI
node scripts/bench-image-models.mjs --table            # verified.json as Markdown
```

Each model's pictures and a contact sheet land in `/tmp/odm-image-bench` (or
`--out DIR`), so the numbers come with something to judge by eye. Flags:

| Flag | Does |
|---|---|
| `--url` | ComfyUI's address, default `http://127.0.0.1:8188` |
| `--models` | `installed` (default), `all`, or catalog ids, comma-separated |
| `--download --comfy-dir DIR` | fetch a model's missing files into `DIR/models/<folder>` first; a Hugging Face token from `HF_TOKEN` or `~/.cache/huggingface/token` is sent for gated repositories; what was fetched is listed in `<out>/downloaded.json` so it can be removed again |
| `--write` | record the rows in `src/lib/image-models/verified.json` |
| `--hardware ID` | the profile to record when the device is not one the app recognises |
| `--steps N`, `--cfg N`, `--files slot=name`, `--drop-patch Node`, `--label L` | try other settings or another precision of a file; leave `--write` off for these |
| `--timeout-min N` | give up on one picture after N minutes (default 30) |

`verified.json` holds one row per model and hardware profile: the files that
ran, steps, seconds for each picture shape, the first picture, peak memory, a
verdict (`recommended`, `works`, `fails`) and a note. The timing fields come
from the script; the verdict and note come from looking at the pictures, and a
later `--write` keeps them. Hardware profiles live in `HARDWARE_PROFILES`
(`src/lib/image-models/curate.ts`), each a name pattern matched against the
device ComfyUI reports; add one for your GPU, run with `--write`, and send the
rows with the contact sheets in a pull request. `npm test` checks every row
names a catalog model and a known profile, once each.

The run so far on the reference machine, an AMD Ryzen AI Max+ 395 with 128 GB
of unified memory, with the default storyteller model (qwen3.6-35b at Q8) loaded
beside ComfyUI the way a table runs:

On strix-halo (AMD Radeon 8060S Graphics, ComfyUI 0.39.2, torch 2.14.0+rocm7.2):

| Model | Verdict | Portrait (square) | Scene (landscape) | First picture | Peak GPU memory | Steps | Notes |
|---|---|---|---|---|---|---|---|
| FLUX.2 [klein] 4B | recommended | 15 s | 14 s | 17 s | 20.5 GB | 4 | Fastest measured and among the best: stocky dwarves without elf ears, a true owlbear, a detailed forge. Apache-2.0. Can leave a faint logo mark in a corner. |
| Z-Image Turbo | recommended | 19 s | 15 s | 24 s | 23.6 GB | 8 | Clean painterly portraits and a true owl-bear; quickest good model here. Dwarves can come out with elf ears. |
| Qwen Image 2.1 Turbo | recommended | 45 s | 35 s | 55 s | 21.9 GB | 8 | Nearly the base model's pictures at a third of the time: right dwarf, right owlbear, readable scene. |
| Krea-2 Turbo | recommended | 59 s | 50 s | 38 s | 28.5 GB | 8 | The most tabletop-looking pictures measured: a stout dwarf cleric, a true owlbear, a forge with anvils, bridge and adventurers. Slower than klein or Z-Image Turbo. Krea-2 Community License; check its terms before commercial use. |
| FLUX.1 schnell | works | 30 s | 25 s | 39 s | 32.6 GB | 4 | Paints dwarves as elves, the owlbear as a plain owl, and scribbles signature-like text into corners. |
| Stable Diffusion XL | works | 43 s | 31 s | 41 s | 12.3 GB | 25 | ODM's default CyberRealistic XL: dwarves come out human and the owlbear as an owl. |
| Pony Diffusion XL | works | 44 s | 32 s | 43 s | 12.2 GB | 25 | Drifts to anime faces and light backgrounds, misses the scene and paints the owlbear as an owl. |
| Qwen Image 2.1 | works | 2 min 8 s | 1 min 34 s | 1 min 50 s | 22 GB | 25 | The most faithful pictures measured, but over two minutes each; the Turbo build looks almost the same. |
| FLUX.2 [klein] 4B Base | works | 2 min 10 s | 1 min 39 s | 2 min 15 s | 20.5 GB | 20 | Pictures much like the distilled klein 4B at eight times the time; worth it only for its real negative prompt. |
| Z-Image | works | 3 min 26 s | 2 min 31 s | 3 min 37 s | 18.3 GB | 25 | Good owlbear and scene, but three and a half minutes a picture with the int8 weights; one portrait came out as a framed print on a mat. |

## OpenAI

The one backend that needs no GPU at all. Pick **OpenAI** in the Images panel
and every picture (scene art, location maps, portraits) is made by OpenAI's
images API and saved alongside the rest. Renders bill to whichever key the
request finds, in this order:

1. the key in **Admin > Image generation**
2. `OPENAI_IMAGE_API_KEY`, then `OPENAI_API_KEY`
3. **the story's own OpenAI text key**, when that story's Text Model points at
   `api.openai.com`

That third rule is what makes a bring-your-own-key table work with one key
instead of two: the DM model and the pictures are two APIs on the same
account, so pasting the key once in the Text Model panel covers both. It is
gated on the host, so a key for llama.cpp, LM Studio or OpenRouter is never
sent to OpenAI. Keys stay server-side either way; the campaign's settings are
masked before they reach any player.

Blank model = `gpt-image-1`; set `OPENAI_IMAGE_MODEL` (or the admin field) for
anything else. `OPENAI_IMAGE_BASE_URL` exists for OpenAI-compatible image
proxies. The app's fast/slow dial maps onto the quality tiers (`medium` and
`high` for the gpt-image family, `standard` and `hd` for dall-e), so **slow**
is several times the price of **fast**. Notes:

- Character portrait references are not used by this backend, same as ComfyUI;
  the picture comes from the text prompt alone.
- Nothing is probed: a backend with no key simply records the request and the
  placeholder tells the table a picture is coming.
- Prompts go to OpenAI, so this is the one backend that is not on-device.
- A key that lives only in ONE campaign's Story AI panel (an admin's
  campaign: a player's campaign always runs on the server's keys) covers that
  campaign's own pictures: scene art, the story image tool, and location maps.
  Campaign covers and library portraits are painted from the server's default
  image settings, because a library character belongs to no campaign. Put the
  key in **Admin > Image generation** (or make OpenAI the server-wide text
  backend) and every picture on the server is covered.
- In the desktop and Android apps none of that applies: the key is saved once
  for the device on the app's **Story AI** screen, and it covers every
  picture in every campaign on that device, covers and portraits included.

## AMD GPUs

On supported Radeon cards the Windows launcher runs the FLUX backends
natively through AMD's official PyTorch-on-Windows (ROCm) wheels — no NVIDIA
hardware required. Supported by AMD's ROCm 7.2.x Windows release: RX 9070 XT,
RX 9070, RX 9060 XT, RX 7900 XTX, RX 7700, Radeon AI PRO R9700, and Radeon
PRO W7900. Requirements the launcher handles or checks for you:

- Python 3.12 (AMD's wheels only ship for 3.12; the launcher creates or
  rebuilds the image venv with it automatically)
- AMD Adrenalin 26.2.2 or newer graphics driver (install this yourself)

`Launch-Windows.bat` detects a supported Radeon automatically when no NVIDIA
GPU is present. Overrides: set `OPEN_DUNGEON_ROCM=0` to disable the AMD path,
or `OPEN_DUNGEON_ROCM=1` to try it on an unlisted Radeon (untested; expect
rough edges). AMD notes known convolution performance gaps on RX 9000-series
Windows drivers, so the VAE decode step may be slower than the raw
transformer — still enormously faster than the CPU fallback.

On Linux, install the ROCm build of PyTorch into `ultra-fast-image-gen`'s
venv instead (`pip install torch torchvision --index-url
https://download.pytorch.org/whl/rocm6.4`) and run with
`IMAGE_SERVER_DEVICE=cuda` — PyTorch's ROCm build exposes the CUDA device
API. AMD cards without official PyTorch support (RX 7800/7600, RX 6000
series and older) can use the ComfyUI backend above, or fall back to CPU.

## The story image tool

The narrator can call a `generate_image` function tool through the selected
text provider. The app turns that tool call into a request against the
selected image backend, using the current image settings for backend, mode,
and aspect ratio. Old or interrupted image requests show as
`Image tool requested` with a Generate button instead of pretending a job is
still running.
