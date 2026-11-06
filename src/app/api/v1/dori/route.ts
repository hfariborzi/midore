import { z } from "zod";
import { requestPlace } from "@/lib/request-place";
import { json, withDevice } from "@/lib/api-v1";
import { runTurn, type DoriEvent } from "@/lib/dori/agent";
import { rateLimitKey } from "@/lib/rate-limit";

export const maxDuration = 60;

const schema = z.object({ text: z.string().trim().min(1).max(8000) });

/** One message to Dori from the app's brain-dump window; returns her reply when the turn is done. */
export async function POST(req: Request) {
  return withDevice(req, "dori", async (user) => {
    if (!user.doriConsentAt) return json({ error: "Turn on Dori in Midore's settings first." }, 400);
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: "Write something for Dori" }, 400);
    await rateLimitKey(`dori:${user.id}`, 20, 60);
    let reply: Extract<DoriEvent, { type: "reply" }> | null = null;
    let error: string | null = null;
    await runTurn(user, { text: parsed.data.text, mode: "chat", near: requestPlace(req.headers) }, (e) => {
      if (e.type === "reply") reply = e;
      if (e.type === "error") error = e.text;
    });
    const r = reply as Extract<DoriEvent, { type: "reply" }> | null;
    if (!r) return json({ error: error ?? "Dori could not answer. Try again." }, 502);
    return json({ text: r.text, actions: r.meta.actions ?? [] });
  });
}
