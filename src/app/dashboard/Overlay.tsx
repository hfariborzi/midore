"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { X } from "lucide-react";
import { DORI_STATUS, type DoriStatusDetail } from "./DoriPanel";

const TITLES: [string, string][] = [
  ["/dashboard/tasks", "Tasks"],
  ["/dashboard/meetings", "Meetings"],
  ["/dashboard/settings", "Settings"],
];
const BOOKING_TABS: [string, string][] = [
  ["/dashboard/event-types", "Meeting types"],
  ["/dashboard/availability", "Availability"],
  ["/dashboard/bookings", "Bookings"],
];

/**
 * Every dashboard page other than the calendar opens here, as a sheet over the calendar. The calendar lives in the
 * layout, so it keeps its place in the week while sheets open and close.
 */
export function Overlay({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const open = path !== "/dashboard";
  const close = useCallback(() => router.push("/dashboard", { scroll: false }), [router]);
  // When Dori is docked, sheets open beside her instead of over her.
  const [doriOpen, setDoriOpen] = useState(false);
  useEffect(() => {
    const onStatus = (e: Event) => setDoriOpen((e as CustomEvent<DoriStatusDetail>).detail.open);
    window.addEventListener(DORI_STATUS, onStatus);
    return () => window.removeEventListener(DORI_STATUS, onStatus);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;
  const booking = BOOKING_TABS.some(([href]) => path.startsWith(href));
  const title = TITLES.find(([href]) => path.startsWith(href))?.[1];

  return (
    <div className={`fixed inset-y-0 left-0 z-40 flex justify-end bg-scrim/50 ${doriOpen ? "right-0 md:right-[400px]" : "right-0"}`} onClick={close}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={booking ? "Booking" : title}
        className="animate-sheet flex h-full w-full max-w-4xl flex-col border-l border-line bg-canvas pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-(--shadow-modal)"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2 sm:px-5">
          {booking ? (
            <nav className="flex min-w-0 gap-1 overflow-x-auto">
              {BOOKING_TABS.map(([href, label]) => {
                const active = path.startsWith(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    scroll={false}
                    aria-current={active ? "page" : undefined}
                    className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium ${active ? "bg-accent-subtle text-accent-soft" : "text-muted hover:bg-hover hover:text-ink"}`}
                  >
                    {label}
                  </Link>
                );
              })}
            </nav>
          ) : (
            <span className="eyebrow px-1">{title}</span>
          )}
          <button type="button" onClick={close} className="btn-ghost ml-auto p-2" aria-label="Close and go back to the calendar" title="Close (Esc)">
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">{children}</div>
      </section>
    </div>
  );
}
