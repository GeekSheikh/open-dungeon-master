import { z } from "zod";
import { currentUser, unauthorized } from "@/lib/auth";
import { webhookUrl } from "@/lib/agents/webhooks";
import { receiverUrl } from "@/lib/agents/receiver-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Whether this server would send player webhooks to a receiver address, so
// Settings can say so before the player sets the receiver up. It answers yes
// or no for the one address asked; the admin's list itself is not shown.
const schema = z.object({ url: z.string().max(2048) });

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) {
    return unauthorized();
  }
  if (user.mustChangePassword) {
    return Response.json({ error: "Set a new password to continue." }, { status: 403 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "Give a receiver address." }, { status: 400 });
  }
  let url: string;
  try {
    url = receiverUrl(parsed.data.url);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Give a receiver address." }, { status: 400 });
  }
  let allowed = true;
  try {
    webhookUrl(url);
  } catch {
    allowed = false;
  }
  return Response.json({ url, origin: new URL(url).origin, allowed, admin: user.isAdmin });
}
