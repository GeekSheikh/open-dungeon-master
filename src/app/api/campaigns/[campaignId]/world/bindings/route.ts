import { isErrorResponse, requireStoryAuthority } from "@/lib/campaign-api";
import { entriesBoundTo } from "@/lib/db/world-bindings";
import { getWorldDoc } from "@/lib/db/world-forge";
import { BINDING_KINDS, type BindingKind } from "@/lib/worldforge/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The World entries that link to one playable record (audit finding WF-17),
// for the record's own tool: the way back to each entry, and the names to
// give before the record is deleted. ?kind=monster|item&ref=homebrew:<id>
export async function GET(request: Request, { params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  const context = await requireStoryAuthority(campaignId);
  if (isErrorResponse(context)) {
    return context;
  }
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") as BindingKind;
  const ref = (url.searchParams.get("ref") ?? "").slice(0, 120);
  if (!BINDING_KINDS.includes(kind) || !ref) {
    return Response.json({ error: "Name a kind and a record." }, { status: 400 });
  }
  return Response.json({ entries: entriesBoundTo(campaignId, getWorldDoc(campaignId), kind, ref) });
}
