import Link from "next/link";
import { DateTime } from "luxon";
import { requireUser } from "@/lib/auth";
import { listMeetings } from "@/lib/meetings";
import { StartButtons } from "./StartButtons";

export const metadata = { title: "Meetings" };

export default async function MeetingsPage() {
  const user = await requireUser();
  const list = await listMeetings(user.id);
  const when = (d: Date) => DateTime.fromJSDate(d).setZone(user.timezone).toFormat("ccc d LLL, H:mm");
  const length = (a: Date, b: Date | null) => {
    if (!b) return null;
    const min = Math.max(1, Math.round((b.getTime() - a.getTime()) / 60_000));
    return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
  };
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink">Meetings</h1>
          <p className="mt-1 max-w-xl text-sm text-muted">
            Record a meeting or just take notes. Dori writes the summary, what was decided and who does what next; your
            action items can become tasks. When a meeting on your calendar starts, Midore offers to take notes.
          </p>
        </div>
        <StartButtons disabled={!user.doriConsentAt} />
      </div>
      {!user.doriConsentAt && (
        <p className="card p-4 text-sm text-muted">
          Meeting notes use Dori. <Link className="link" href="/dashboard/settings">Turn Dori on in Settings</Link> to start.
        </p>
      )}
      {list.length === 0 ? (
        <p className="text-sm text-faint">No meetings yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {list.map((m) => (
            <li key={m.id}>
              <Link href={`/dashboard/meetings/${m.id}`} scroll={false} className="block px-4 py-3 hover:bg-hover">
                <div className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">{m.title}</span>
                  <span className="shrink-0 text-xs text-faint">{when(m.startedAt)}</span>
                </div>
                <div className="mt-0.5 truncate text-sm text-muted">
                  {m.status === "recording"
                    ? "In progress"
                    : (m.summary?.summary[0] ?? (m.notes.trim() ? m.notes.trim().split("\n")[0] : "No notes"))}
                </div>
                <div className="mt-1 text-xs text-faint">
                  {[m.recorded ? "Recorded" : "Notes only", length(m.startedAt, m.endedAt), m.summary?.actions.length ? `${m.summary.actions.length} action item${m.summary.actions.length === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
