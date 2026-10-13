import type { ComfyFile } from "./types.ts";

// Text encoders and VAEs several models share, defined once so a download is
// counted once. Each url is the Comfy-Org repackage ComfyUI's own templates
// point at; sizes are names[0]'s, in GB.

const HF = "https://huggingface.co";

export const AE: ComfyFile = {
  folder: "vae",
  names: ["ae.safetensors", "ae.sft"],
  family: /flux.*vae|vae.*flux|z[-_ ]?image.*vae/i,
  url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors`,
  sizeGb: 0.34,
  what: "the FLUX VAE, ae.safetensors (models/vae)",
};

export const FLUX2_VAE: ComfyFile = {
  folder: "vae",
  names: ["flux2-vae.safetensors", "full_encoder_small_decoder.safetensors"],
  family: /flux[-_ ]?2.*vae/i,
  url: `${HF}/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors`,
  sizeGb: 0.34,
  what: "the FLUX.2 VAE (models/vae)",
};

export const QWEN_IMAGE_VAE: ComfyFile = {
  folder: "vae",
  names: ["qwen_image_vae.safetensors"],
  family: /qwen[-_ ]?image[-_ ]?vae/i,
  url: `${HF}/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors`,
  sizeGb: 0.25,
  what: "the Qwen-Image VAE (models/vae)",
};

export const CLIP_L: ComfyFile = {
  folder: "text_encoders",
  names: ["clip_l.safetensors"],
  family: /^clip[-_ ]?l\b(?!.*hidream)/i,
  url: `${HF}/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors`,
  sizeGb: 0.25,
  what: "the CLIP-L text encoder (models/text_encoders)",
};

// Any T5-XXL precision serves FLUX.1, Chroma and HiDream alike.
export const T5XXL: ComfyFile = {
  folder: "text_encoders",
  names: ["t5xxl_fp8_e4m3fn_scaled.safetensors", "t5xxl_fp16.safetensors", "t5xxl_fp8_e4m3fn.safetensors"],
  family: /^t5[-_ ]?xxl/i,
  url: `${HF}/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn_scaled.safetensors`,
  sizeGb: 5.16,
  what: "the T5-XXL text encoder (models/text_encoders)",
};

export const QWEN3_4B: ComfyFile = {
  folder: "text_encoders",
  names: ["qwen_3_4b.safetensors", "qwen_3_4b_fp8_mixed.safetensors"],
  family: /qwen[-_ ]?3[-_ ]?4b/i,
  url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors`,
  sizeGb: 8.04,
  what: "the Qwen 3 4B text encoder (models/text_encoders)",
};

export const QWEN3_8B: ComfyFile = {
  folder: "text_encoders",
  names: ["qwen_3_8b_fp8mixed.safetensors", "qwen_3_8b.safetensors"],
  family: /qwen[-_ ]?3[-_ ]?8b/i,
  url: `${HF}/Comfy-Org/flux2-klein-9B/resolve/main/split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors`,
  sizeGb: 8.66,
  what: "the Qwen 3 8B text encoder (models/text_encoders)",
};

export const QWEN25_VL_7B: ComfyFile = {
  folder: "text_encoders",
  names: ["qwen_2.5_vl_7b_fp8_scaled.safetensors", "qwen_2.5_vl_7b.safetensors"],
  family: /qwen[-_ ]?2\.5[-_ ]?vl[-_ ]?7b/i,
  url: `${HF}/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors`,
  sizeGb: 9.38,
  what: "the Qwen 2.5 VL 7B text encoder (models/text_encoders)",
};

export const QWEN3VL_4B: ComfyFile = {
  folder: "text_encoders",
  names: ["qwen3vl_4b_fp8_scaled.safetensors", "qwen3vl_4b_bf16.safetensors"],
  family: /qwen[-_ ]?3[-_ ]?vl[-_ ]?4b/i,
  url: `${HF}/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors`,
  sizeGb: 5.24,
  what: "the Qwen 3 VL 4B text encoder (models/text_encoders)",
};

export const QWEN3VL_8B: ComfyFile = {
  folder: "text_encoders",
  names: ["qwen3vl_8b_fp8_scaled.safetensors", "qwen3vl_8b_int8_convrot.safetensors", "qwen3vl_8b_bf16.safetensors"],
  family: /qwen[-_ ]?3[-_ ]?vl[-_ ]?8b/i,
  url: `${HF}/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/qwen3vl_8b_fp8_scaled.safetensors`,
  sizeGb: 10.59,
  what: "the Qwen 3 VL 8B text encoder (models/text_encoders)",
};

export const BYT5_GLYPH: ComfyFile = {
  folder: "text_encoders",
  names: ["byt5_small_glyphxl_fp16.safetensors"],
  family: /byt5.*glyph/i,
  url: `${HF}/Comfy-Org/HunyuanImage_2.1_ComfyUI/resolve/main/split_files/text_encoders/byt5_small_glyphxl_fp16.safetensors`,
  sizeGb: 0.44,
  what: "the ByT5 glyph encoder (models/text_encoders)",
};

export const MINISTRAL_3B: ComfyFile = {
  folder: "text_encoders",
  names: ["ministral-3-3b.safetensors"],
  family: /ministral[-_ ]?3[-_ ]?3b/i,
  url: `${HF}/Comfy-Org/ERNIE-Image/resolve/main/text_encoders/ministral-3-3b.safetensors`,
  sizeGb: 7.72,
  what: "the Ministral 3 3B text encoder (models/text_encoders)",
};

export function diffusionFile(names: string[], family: RegExp, url: string, sizeGb: number, what: string): ComfyFile {
  return { folder: "diffusion_models", names, family, url, sizeGb, what: `${what} (models/diffusion_models)` };
}

export function checkpointFile(names: string[], family: RegExp, url: string, sizeGb: number, what: string): ComfyFile {
  return { folder: "checkpoints", names, family, url, sizeGb, what: `${what} (models/checkpoints)` };
}

export function loraFile(names: string[], url: string, sizeGb: number, what: string): ComfyFile {
  return { folder: "loras", names, url, sizeGb, what: `${what} (models/loras)` };
}
