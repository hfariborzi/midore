"use client";

import { Mic, NotebookPen } from "lucide-react";
import { START_MEETING, type StartMeetingDetail } from "../MeetingRecorder";

export function StartButtons({ disabled }: { disabled?: boolean }) {
  const start = (detail: StartMeetingDetail) => window.dispatchEvent(new CustomEvent<StartMeetingDetail>(START_MEETING, { detail }));
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-primary" disabled={disabled} onClick={() => start({ record: true })}>
        <Mic size={16} /> Record a meeting
      </button>
      <button type="button" className="btn-ghost" disabled={disabled} onClick={() => start({ record: false })}>
        <NotebookPen size={16} /> Notes only
      </button>
    </div>
  );
}
