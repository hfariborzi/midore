"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MapPin } from "lucide-react";
import { Switch } from "@/components/Switch";
import { parseCoords } from "@/lib/places";
import { addPlaceAction, deleteAutomationAction, deletePlaceAction, removeCheckInAction, setAutomationEnabledAction } from "./routine-actions";

type Place = { id: number; name: string; radiusM: number };
type Rule = { id: number; label: string; enabled: boolean; runs: number; lastRunAt: string | null; oneOff: boolean };
type CheckIn = { id: string; label: string };

/**
 * Places for alerts on arriving or leaving. A place comes from where the browser says you are, or from
 * coordinates or a map link you paste; the phone apps watch them.
 */
export function PlacesSettings({ initial }: { initial: Place[] }) {
  const router = useRouter();
  const [list, setList] = useState(initial);
  const [name, setName] = useState("");
  const [where, setWhere] = useState("");
  const [radius, setRadius] = useState(150);
  const [locating, setLocating] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const save = (lat: number, lng: number) =>
    start(async () => {
      const r = await addPlaceAction({ name, lat, lng, radiusM: radius });
      if (r.error || !r.id) return setMsg({ ok: false, text: r.error ?? "Couldn't save the place" });
      setList((l) => [...l, { id: r.id!, name: name.trim(), radiusM: radius }]);
      setMsg({ ok: true, text: `Saved ${name.trim()}. Ask Dori: "remind me to call Mom when I get ${name.trim().toLowerCase() === "home" ? "home" : `to ${name.trim()}`}".` });
      setName("");
      setWhere("");
      router.refresh();
    });

  const here = () => {
    if (!name.trim()) return setMsg({ ok: false, text: "Give the place a name first" });
    if (!navigator.geolocation) return setMsg({ ok: false, text: "This browser can't tell where you are; paste coordinates or a map link instead" });
    setLocating(true);
    setMsg(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        save(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => {
        setLocating(false);
        setMsg({ ok: false, text: err.code === err.PERMISSION_DENIED ? "Location is blocked for Midore in this browser; paste coordinates or a map link instead" : "Couldn't find where you are; try again or paste a map link" });
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  };

  const fromText = () => {
    if (!name.trim()) return setMsg({ ok: false, text: "Give the place a name first" });
    const c = parseCoords(where);
    if (!c) return setMsg({ ok: false, text: "Paste coordinates (51.04, -114.07) or a Google, Apple or OpenStreetMap link with them" });
    save(c.lat, c.lng);
  };

  return (
    <section className="card p-6">
      <h2 className="text-lg font-semibold">Places</h2>
      <p className="mt-1 max-w-xl text-sm text-muted">
        For reminders when you arrive somewhere or leave (&ldquo;remind me when I leave work&rdquo;). Your phone watches these places
        with the Midore app; Dori only sees their names.
      </p>
      {list.length > 0 && (
        <ul className="mt-4 divide-y divide-line">
          {list.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2.5">
              <MapPin size={16} className="shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{p.name}</span>
              <span className="text-xs text-faint">within {p.radiusM} m</span>
              <button
                type="button"
                className="btn-ghost py-1.5 text-sm"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    await deletePlaceAction(p.id);
                    setList((l) => l.filter((x) => x.id !== p.id));
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-[10rem_1fr]">
        <div>
          <label className="label" htmlFor="place-name">Name</label>
          <input id="place-name" className="input w-full" maxLength={40} placeholder="Home" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="place-where">Coordinates or map link</label>
          <input id="place-where" className="input w-full" placeholder="51.0447, -114.0719" value={where} onChange={(e) => setWhere(e.target.value)} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary text-sm" disabled={pending || locating} onClick={here}>
          {locating ? "Finding you…" : "Use where I am now"}
        </button>
        <button type="button" className="btn-ghost text-sm" disabled={pending || !where.trim()} onClick={fromText}>
          Save from coordinates
        </button>
        <label className="ml-auto flex items-center gap-2 text-sm text-muted">
          Within
          <select className="input py-1.5" value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
            {[100, 150, 250, 500, 1000].map((m) => (
              <option key={m} value={m}>{m} m</option>
            ))}
          </select>
        </label>
      </div>
      {msg && <p className={`mt-3 text-sm ${msg.ok ? "text-muted" : "text-danger"}`} role="status">{msg.text}</p>}
    </section>
  );
}

/** Rules and check-ins set up with Dori, each with a way to pause or remove it. */
export function RoutinesSettings({ rules, checkIns }: { rules: Rule[]; checkIns: CheckIn[] }) {
  const router = useRouter();
  const [ruleList, setRuleList] = useState(rules);
  const [checkInList, setCheckInList] = useState(checkIns);
  const [pending, start] = useTransition();
  const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <section className="card p-6">
      <h2 className="text-lg font-semibold">Rules and check-ins</h2>
      <p className="mt-1 max-w-xl text-sm text-muted">
        Ask Dori for these: &ldquo;every time I finish a chapter, add a review with my supervisor&rdquo;, &ldquo;if the review isn&apos;t done
        by Wednesday, drop it&rdquo;, &ldquo;every Sunday at 6, ask me how the week went&rdquo;.
      </p>
      <h3 className="mt-5 text-sm font-semibold text-ink">Rules</h3>
      {ruleList.length === 0 ? (
        <p className="mt-2 text-sm text-faint">None yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {ruleList.map((r) => (
            <li key={r.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className={`text-sm ${r.enabled ? "text-ink" : "text-faint"}`}>{r.label}</div>
                <div className="text-xs text-faint">
                  {r.runs ? `Ran ${r.runs} time${r.runs === 1 ? "" : "s"}${r.lastRunAt ? `, last ${day(r.lastRunAt)}` : ""}` : "Hasn't run yet"}
                  {r.oneOff && !r.enabled ? " · finished" : ""}
                </div>
              </div>
              {!(r.oneOff && !r.enabled && r.runs) && (
                <Switch
                  checked={r.enabled}
                  disabled={pending}
                  label={r.enabled ? "Pause this rule" : "Turn this rule on"}
                  onChange={(on) =>
                    start(async () => {
                      await setAutomationEnabledAction(r.id, on);
                      setRuleList((l) => l.map((x) => (x.id === r.id ? { ...x, enabled: on } : x)));
                    })
                  }
                />
              )}
              <button
                type="button"
                className="btn-ghost py-1.5 text-sm"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    await deleteAutomationAction(r.id);
                    setRuleList((l) => l.filter((x) => x.id !== r.id));
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3 className="mt-5 text-sm font-semibold text-ink">Check-ins</h3>
      {checkInList.length === 0 ? (
        <p className="mt-2 text-sm text-faint">None yet. The morning brief is set under Dori above.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {checkInList.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1 text-sm text-ink">{c.label}</span>
              <button
                type="button"
                className="btn-ghost py-1.5 text-sm"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    await removeCheckInAction(c.id);
                    setCheckInList((l) => l.filter((x) => x.id !== c.id));
                    router.refresh();
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
