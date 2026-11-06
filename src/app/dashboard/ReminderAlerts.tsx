"use client";

import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bell, Check, X } from "lucide-react";
import type { Alert } from "@/lib/tasks";
import { setTaskStatus } from "./actions";
import { TASKS_CHANGED } from "./DoriPanel";

const LATE_MS = 10 * 60_000; // an alert missed by more than this (the tab was asleep) is not shown
const noSubscribe = () => () => {};

/**
 * Alerts set on tasks and reminders ("remind me at 6"), while Midore is open in the browser: a system notification
 * when the user allowed them, and a card in the corner either way. The phone and desktop apps alert on their own.
 */
export function ReminderAlerts({ alerts }: { alerts: Alert[] }) {
  const router = useRouter();
  const [shown, setShown] = useState<Alert[]>([]);
  const browserPermission = useSyncExternalStore(
    noSubscribe,
    () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission),
    () => "unsupported" as const,
  );
  const [answered, setAnswered] = useState<NotificationPermission | null>(null);
  const permission = answered ?? browserPermission;
  const [pending, start] = useTransition();

  useEffect(() => {
    const fire = (a: Alert) => {
      setShown((list) => (list.some((x) => x.taskId === a.taskId && x.at === a.at) ? list : [...list, a]));
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          new Notification(a.title, { body: "Reminder from Midore", tag: `midore-${a.taskId}-${a.at}` });
        } catch {
          // Some browsers only allow notifications from a service worker; the card still shows.
        }
      }
    };
    const timers = alerts.map((a) => {
      const wait = Date.parse(a.at) - Date.now();
      if (wait < -LATE_MS) return null;
      // setTimeout can't wait longer than ~24 days; the page reloads long before that.
      return window.setTimeout(() => fire(a), Math.max(0, Math.min(wait, 2 ** 31 - 1)));
    });
    return () => timers.forEach((t) => t !== null && window.clearTimeout(t));
  }, [alerts]);

  const dismiss = (a: Alert) => setShown((list) => list.filter((x) => x !== a));
  const done = (a: Alert) =>
    start(async () => {
      await setTaskStatus({ id: a.taskId, status: "done" });
      window.dispatchEvent(new Event(TASKS_CHANGED));
      dismiss(a);
      router.refresh();
    });

  const askable = permission === "default" && alerts.length > 0;
  if (!shown.length && !askable) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {shown.map((a) => (
        <div key={`${a.taskId}:${a.at}`} role="alert" className="pointer-events-auto rounded-xl border border-line bg-paper p-3 text-sm shadow-lg">
          <div className="flex items-start gap-2">
            <Bell size={16} className="mt-0.5 shrink-0 text-amber" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-ink">{a.title}</div>
              <div className="text-xs text-faint">{new Date(a.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</div>
            </div>
            <button type="button" className="text-faint hover:text-ink" aria-label="Dismiss" onClick={() => dismiss(a)}><X size={16} /></button>
          </div>
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-primary py-1 text-xs" disabled={pending} onClick={() => done(a)}><Check size={14} /> Done</button>
            <button type="button" className="btn-ghost py-1 text-xs" onClick={() => dismiss(a)}>Later</button>
          </div>
        </div>
      ))}
      {askable && (
        <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-line bg-paper p-3 text-xs text-muted shadow-lg">
          <Bell size={14} className="shrink-0" />
          <span className="flex-1">Get your reminders as notifications while Midore is open.</span>
          <button type="button" className="btn-secondary py-1 text-xs" onClick={() => Notification.requestPermission().then(setAnswered)}>Turn on</button>
          <button type="button" className="text-faint hover:text-ink" aria-label="Not now" onClick={() => setAnswered("denied")}><X size={14} /></button>
        </div>
      )}
    </div>
  );
}
