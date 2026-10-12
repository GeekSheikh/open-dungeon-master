import { z } from "zod";
import { isErrorResponse, requireAdmin } from "@/lib/admin-api";
import { getGlobalConfig } from "@/lib/db/app-settings";
import { catalogStatus, refreshModelCatalog } from "@/lib/model-registry/catalog";
import { modelChoices } from "@/lib/model-registry/registry";
import { serverEnv } from "@/lib/server-env";
import { keyForListing } from "@/lib/setup/discovery-logic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The admin's model pickers (src/app/admin/ModelChoice.tsx): what the
// backend at an address lists, merged with the model catalog and the
// server's own test results. A typed key is used for this one listing; a
// saved key is sent only to the host it was saved for, never to an address
// somebody just typed. No key ever comes back.

const listSchema = z.object({
  action: z.literal("list"),
  role: z.enum(["story", "utility", "image"]),
  provider: z.enum(["local", "custom", "harness", "images"]),
  baseUrl: z.string().trim().max(500).optional(),
  apiKey: z.string().trim().max(400).optional(),
  model: z.string().trim().max(200).optional(),
  harnessId: z.string().trim().max(20).optional(),
});

const actionSchema = z.discriminatedUnion("action", [listSchema, z.object({ action: z.literal("refresh-catalog") })]);

export async function GET() {
  const admin = await requireAdmin();
  if (isErrorResponse(admin)) {
    return admin;
  }
  return Response.json({ catalog: catalogStatus() });
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (isErrorResponse(admin)) {
    return admin;
  }
  const parsed = actionSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message || "Unknown request." }, { status: 400 });
  }
  if (parsed.data.action === "refresh-catalog") {
    const result = await refreshModelCatalog();
    return Response.json({ ok: result.ok, error: result.error, catalog: catalogStatus() });
  }
  const { role, provider, baseUrl = "", apiKey = "", model = "", harnessId } = parsed.data;
  const config = getGlobalConfig();
  // The keys this server holds, each with the host it was saved for.
  const saved: Array<[string, string]> =
    provider === "images"
      ? [
          [config.images.openaiBaseUrl || serverEnv("OPENAI_IMAGE_BASE_URL") || "https://api.openai.com/v1", config.images.openaiApiKey || serverEnv("OPENAI_IMAGE_API_KEY")],
          [config.text.customBaseUrl || serverEnv("OPENAI_COMPAT_BASE_URL"), config.text.customApiKey || serverEnv("OPENAI_COMPAT_API_KEY")],
        ]
      : [
          [config.text.customBaseUrl || serverEnv("OPENAI_COMPAT_BASE_URL"), config.text.customApiKey || serverEnv("OPENAI_COMPAT_API_KEY")],
          [config.text.utilityBaseUrl || serverEnv("UTILITY_TEXT_BASE_URL"), config.text.utilityApiKey],
        ];
  const key =
    saved.map(([savedBaseUrl, savedKey]) => keyForListing({ typed: apiKey, savedKey, savedBaseUrl, baseUrl })).find(Boolean) ?? "";
  const choices = await modelChoices({ role, provider, baseUrl, apiKey: key, selected: model, harnessId });
  return Response.json(choices);
}
