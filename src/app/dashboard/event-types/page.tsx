import Link from "next/link";
import { Clock, Eye, Link2, Lock, Pencil, Plus, QrCode, Users } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { listEventTypes } from "@/lib/data";
import { requestBaseUrl } from "@/lib/origin";
import { locationLabel } from "@/lib/locations";
import { CopyButton } from "@/components/CopyButton";
import { LocationIcon } from "@/components/LocationIcon";
import { EventTypeActions } from "./EventTypeActions";
import { toPalette } from "@/lib/palette";

export const metadata = { title: "Event types" };

export default async function EventTypesPage() {
  const user = await requireUser();
  const types = await listEventTypes(user.id);
  const base = await requestBaseUrl();

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Event types</h1>
          <p className="mt-2 text-sm text-muted">The kinds of meetings people can book with you. Each one has its own link.</p>
        </div>
        <Link href="/dashboard/event-types/new" className="btn-primary"><Plus size={16} /> New event type</Link>
      </div>

      {types.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-strong p-12 text-center text-sm text-faint">
          No event types yet. Create one to get a booking link.
        </div>
      ) : (
        <ul className="space-y-3">
          {types.map((t) => {
            const url = `${base}/${user.username}/${t.slug}`;
            return (
              <li
                key={t.id}
                className={`card relative flex flex-col gap-4 overflow-hidden p-5 sm:flex-row sm:items-center sm:justify-between ${t.active ? "" : "opacity-60"}`}
              >
                <span className="absolute inset-y-0 left-0 w-1" style={{ background: toPalette(t.color) }} />
                <div className="min-w-0 space-y-2.5 pl-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/dashboard/event-types/${t.id}`} className="text-lg font-semibold tracking-tight hover:text-accent-soft">
                      {t.title}
                    </Link>
                    {t.hidden && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-hover px-1.5 py-0.5 text-xs font-medium text-muted"><Lock size={11} /> Secret</span>
                    )}
                    {t.seats > 1 && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-accent/20 px-1.5 py-0.5 text-xs font-medium text-accent-soft"><Users size={11} /> Group · {t.seats}</span>
                    )}
                    {!t.active && <span className="rounded-md bg-hover px-1.5 py-0.5 text-xs font-medium text-faint">Off</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
                    <span className="inline-flex items-center gap-1.5 tnum"><Clock size={14} strokeWidth={1.75} />{t.durations.map((d) => `${d} min`).join(" / ")}</span>
                    {t.locations.map((l, i) => (
                      <span key={i} className="inline-flex items-center gap-1.5"><LocationIcon type={l.type} size={14} />{locationLabel(l)}</span>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex max-w-full min-w-0 items-center gap-2 rounded-lg bg-well px-2.5 py-1 font-mono text-xs text-faint">
                      <Link2 size={13} className="shrink-0" />
                      <span className="truncate">{url.replace(/^https?:\/\//, "")}</span>
                    </span>
                    <CopyButton text={url} className="btn-ghost px-2 py-1 text-xs" />
                    {t.active && (
                      <a href={`/api/booking-qr/${user.username}/${t.slug}`} download className="btn-ghost px-2 py-1 text-xs">
                        <QrCode size={14} /> QR code PNG
                      </a>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1 pl-2 sm:pl-0">
                  <EventTypeActions id={t.id} active={t.active} />
                  <Link href={`/dashboard/event-types/${t.id}`} className="btn-ghost px-3 py-1.5"><Pencil size={15} /> Edit</Link>
                  <a href={url} target="_blank" rel="noreferrer" className="btn-ghost px-3 py-1.5"><Eye size={15} /> View</a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
