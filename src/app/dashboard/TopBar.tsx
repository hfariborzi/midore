"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarClock, ExternalLink, ListChecks, LogOut, Mic, Settings, Sparkles } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { CopyButton } from "@/components/CopyButton";
import { FullLogo, LogoMark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DORI_STATUS, TOGGLE_DORI, type DoriStatusDetail } from "./DoriPanel";

/** Where the calendar renders its own controls (today, arrows, range, day/week) inside the top bar. */
export const CALENDAR_CONTROLS_ID = "calendar-controls";

const BOOKING_PATHS = ["/dashboard/event-types", "/dashboard/availability", "/dashboard/bookings"];

/**
 * The app's only navigation. The calendar is always underneath; Tasks, Booking and Settings open over it, and
 * Dori docks beside it.
 */
export function TopBar({ name, email, image, publicUrl }: { name: string; email: string; image: string | null; publicUrl: string }) {
  const path = usePathname();
  const [dori, setDori] = useState<DoriStatusDetail>({ open: false, news: false });

  useEffect(() => {
    const onStatus = (e: Event) => setDori((e as CustomEvent<DoriStatusDetail>).detail);
    window.addEventListener(DORI_STATUS, onStatus);
    return () => window.removeEventListener(DORI_STATUS, onStatus);
  }, []);

  const items = [
    { href: "/dashboard/tasks", label: "Tasks", Icon: ListChecks, active: path.startsWith("/dashboard/tasks") },
    { href: "/dashboard/meetings", label: "Meetings", Icon: Mic, active: path.startsWith("/dashboard/meetings") },
    { href: "/dashboard/event-types", label: "Booking", Icon: CalendarClock, active: BOOKING_PATHS.some((p) => path.startsWith(p)) },
    { href: "/dashboard/settings", label: "Settings", Icon: Settings, active: path.startsWith("/dashboard/settings") },
  ];
  const btn = (active: boolean) =>
    `relative inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium transition ${
      active ? "bg-accent-subtle text-accent-soft" : "text-muted hover:bg-hover hover:text-ink"
    }`;

  return (
    <header className="z-30 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-3 py-2 sm:px-4">
      <Link href="/dashboard" className="shrink-0 text-ink" aria-label="Calendar">
        <span className="hidden sm:inline">
          <FullLogo height="20px" />
        </span>
        <span className="sm:hidden">
          <LogoMark size={16} />
        </span>
      </Link>

      <div id={CALENDAR_CONTROLS_ID} className="order-last flex w-full min-w-0 items-center md:order-none md:ml-4 md:w-auto md:flex-1" />

      <nav className="ml-auto flex items-center gap-0.5 md:ml-0">
        {items.slice(0, 3).map(({ href, label, Icon, active }) => (
          <Link key={href} href={active ? "/dashboard" : href} scroll={false} className={btn(active)} aria-current={active ? "page" : undefined} title={label}>
            <Icon size={17} strokeWidth={1.75} />
            <span className="hidden lg:inline">{label}</span>
          </Link>
        ))}
        <button type="button" className={btn(dori.open)} onClick={() => window.dispatchEvent(new Event(TOGGLE_DORI))} aria-pressed={dori.open} title="Dori">
          <Sparkles size={17} strokeWidth={1.75} />
          <span className="hidden lg:inline">Dori</span>
          {dori.news && !dori.open && <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-amber" aria-label="News from Dori" />}
        </button>
        {items.slice(3).map(({ href, label, Icon, active }) => (
          <Link key={href} href={active ? "/dashboard" : href} scroll={false} className={btn(active)} aria-current={active ? "page" : undefined} title={label}>
            <Icon size={17} strokeWidth={1.75} />
            <span className="hidden lg:inline">{label}</span>
          </Link>
        ))}
        <AccountMenu name={name} email={email} image={image} publicUrl={publicUrl} />
      </nav>
    </header>
  );
}

function AccountMenu({ name, email, image, publicUrl }: { name: string; email: string; image: string | null; publicUrl: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const shortUrl = publicUrl.replace(/^https?:\/\//, "");

  return (
    <div ref={ref} className="relative ml-1">
      <button type="button" onClick={() => setOpen(!open)} className="rounded-full p-0.5 hover:ring-2 hover:ring-line" aria-haspopup="menu" aria-expanded={open} title={name || email}>
        <Avatar name={name || email} image={image} size={30} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-2 w-72 rounded-lg border border-line bg-modal p-2 shadow-(--shadow-modal)">
          <div className="px-2 py-2">
            <div className="truncate font-medium text-ink">{name}</div>
            <div className="truncate text-xs text-faint">{email}</div>
          </div>
          <div className="my-1 border-t border-line" />
          <p className="eyebrow px-2 pt-2">Your booking page</p>
          <a href={publicUrl} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted hover:bg-hover hover:text-ink">
            <ExternalLink size={15} className="shrink-0" />
            <span className="truncate">{shortUrl}</span>
          </a>
          <CopyButton text={publicUrl} className="btn-ghost w-full justify-start px-2 py-1.5 text-sm" />
          <div className="my-1 border-t border-line" />
          <ThemeToggle className="w-full justify-start px-2" />
          <form action="/api/auth/logout" method="post">
            <button className="btn-ghost w-full justify-start px-2">
              <LogOut size={16} /> Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
