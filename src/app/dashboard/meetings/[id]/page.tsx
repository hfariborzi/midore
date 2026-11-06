import { notFound } from "next/navigation";
import { DateTime } from "luxon";
import { requireUser } from "@/lib/auth";
import { getMeeting } from "@/lib/meetings";
import { MeetingDetail } from "./MeetingDetail";

export const metadata = { title: "Meeting" };

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const m = await getMeeting(user.id, Number((await params).id));
  if (!m) notFound();
  const start = DateTime.fromJSDate(m.startedAt).setZone(user.timezone);
  const minutes = m.endedAt ? Math.max(1, Math.round((m.endedAt.getTime() - m.startedAt.getTime()) / 60_000)) : null;
  return (
    <MeetingDetail
      meeting={{ id: m.id, title: m.title, status: m.status, recorded: m.recorded, transcript: m.transcript, notes: m.notes, summary: m.summary }}
      when={`${start.toFormat("cccc d LLLL yyyy, H:mm")}${minutes ? ` · ${minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`}` : ""}`}
    />
  );
}
