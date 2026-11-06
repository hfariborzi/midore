import Link from "next/link";
import { ArrowRight, Check, Code2, Leaf, MapPin, Plus, ShieldCheck } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { APP_NAME, SOURCE_URL } from "@/lib/config";
import { SignInButtons } from "@/components/SignInButtons";
import { FullLogo } from "@/components/Logo";
import { SiteFooter } from "@/components/SiteFooter";
import { DoriLive } from "@/components/DoriLive";
import { PlannerBoard } from "@/components/landing/PlannerBoard";
import { BookingCard } from "@/components/landing/BookingCard";
import styles from "@/components/landing/landing.module.css";

const WEEK_HOLDS: { text: string; kind: "work" | "life" | "people" }[] = [
  { text: "Quarterly report", kind: "work" },
  { text: "Call mum", kind: "people" },
  { text: "5k run", kind: "life" },
  { text: "Dentist", kind: "life" },
  { text: "Board prep", kind: "work" },
  { text: "Brunch with Sam", kind: "people" },
  { text: "Meal prep", kind: "life" },
  { text: "Pay rent", kind: "life" },
  { text: "Review contract", kind: "work" },
  { text: "Movie night", kind: "people" },
  { text: "Yoga", kind: "life" },
  { text: "Nap", kind: "life" },
  { text: "Send invoices", kind: "work" },
  { text: "Kids' recital", kind: "people" },
];

const STEPS = [
  { title: "Connect your calendars", body: "Google or Microsoft, as many accounts as you have: work, personal, family." },
  { title: "Empty your head", body: "Type or say everything on your mind, with dates where there are any." },
  { title: "Get a week that works", body: "Midore fits it all around your meetings, deadlines first, with room left to breathe." },
];

const TRUST = [
  { Icon: ShieldCheck, text: "Calendar access verified by Google" },
  { Icon: Leaf, text: "AI providers keep no copy of your data and never train on it" },
  { Icon: Code2, text: "Open source on GitHub", href: SOURCE_URL },
  { Icon: MapPin, text: "Made in Canada" },
];

const FAQ = [
  ["Will it move my meetings?", "No. Midore never moves or deletes your events on its own. It only places your own plans in the free time, and you can pin anything where you want it. If you ask Dori to move one of your own events, she shows you the change first."],
  ["Is it only for work?", "No. Workouts, friends, chores and rest go on the same week as your work, and Dori can suggest what to do with a free afternoon."],
  ["Do I have to use the AI?", "No. Booking, tasks and the planner work without it. Dori stays off until you turn her on."],
  [
    "What does Midore do with my calendar?",
    "It reads when you are busy so it can plan around it and take bookings, and it adds the events you create or that people book. With Dori on, she sees event titles and times, never who is attending.",
  ],
  ["Is it free?", "Yes. Booking pages, tasks, projects and the planner are free."],
];

export default async function Home() {
  const user = await getCurrentUser().catch(() => null);
  const action = (start: boolean) =>
    user ? (
      <Link href="/dashboard" className="btn-primary h-11 px-6 text-base">
        Open {APP_NAME} <ArrowRight size={16} />
      </Link>
    ) : (
      <SignInButtons row start={start} dark />
    );

  return (
    <div className={`${styles.root} flex min-h-[100dvh] flex-1 flex-col`}>
      <main className="flex-1">
        {/* The board: the whole first viewport is the planner, with the offer written on it. */}
        <section className="px-2 pt-2 sm:px-4 sm:pt-4 lg:px-6 lg:pt-5">
          <div className={`${styles.frame} mx-auto max-w-[1440px]`}>
            <div className={styles.board}>
              <header className="flex items-center justify-between">
                <Link href="/" aria-label={`${APP_NAME} home`} className="text-ink">
                  <FullLogo height="23px" markClassName="text-accent" />
                </Link>
                {user ? (
                  <Link href="/dashboard" className="btn-primary h-9 px-4">Open {APP_NAME}</Link>
                ) : (
                  <Link href="/login" className="btn-secondary h-9 px-4">Start free <ArrowRight size={14} /></Link>
                )}
              </header>

              <div className="mt-8 grid gap-10 lg:mt-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.42fr)] lg:items-center lg:gap-12">
                <div className="max-w-xl">
                  <h1 className={`${styles.display} text-[2.75rem] leading-[0.98] text-ink sm:text-6xl lg:text-[3.4rem] xl:text-[3.9rem]`}>
                    Your week, <span className="text-accent">planned</span> around what matters.
                  </h1>
                  <p className="mt-6 max-w-md text-lg leading-relaxed text-muted">
                    Meetings stay where they are. {APP_NAME} fits work, friends, workouts and rest into the time around them.
                  </p>
                  <div className="mt-8">{action(true)}</div>
                  <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted">
                    {["Never moves your meetings", "Free", "AI off until you turn it on"].map((c) => (
                      <li key={c} className="flex items-center gap-1.5">
                        <Check size={15} strokeWidth={2.25} className="text-accent" aria-hidden /> {c}
                      </li>
                    ))}
                  </ul>
                </div>
                <PlannerBoard />
              </div>
            </div>
          </div>
        </section>

        {/* Life, not just work */}
        <section className="py-20 sm:py-28">
          <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
            <h2 className={`${styles.display} text-4xl leading-[1.02] text-ink sm:text-6xl`}>Not just work. The whole week.</h2>
            <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-muted">
              {APP_NAME} plans the things that keep you going too: the run, the call home, groceries, and the afternoon you keep free on purpose.
            </p>
          </div>
          <div className={`${styles.marquee} mt-12`} aria-hidden>
            <div className={`${styles.marqueeTrack} py-3`}>
              {[...WEEK_HOLDS, ...WEEK_HOLDS].map((w, i) => (
                <span key={i} className={styles.chip} data-kind={w.kind} style={{ "--tilt": `${((i * 7) % 5) - 2}deg` } as React.CSSProperties}>
                  {w.text}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* Dori */}
        <section className="border-y border-line bg-surface px-4 py-20 sm:px-6 sm:py-28">
          <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[1fr_1.1fr] lg:gap-20">
            <div className={styles.reveal}>
              <h2 className={`${styles.display} text-4xl leading-[1.02] text-ink sm:text-5xl`}>Ask Dori what to do with a free Sunday.</h2>
              <p className="mt-5 max-w-lg text-lg leading-relaxed text-muted">
                Dori, your {APP_NAME} assistant, knows what is already on your week. Ask by voice or text, and she suggests what fits, from seeing friends to
                doing nothing at all. She is optional and stays off until you turn her on.
              </p>
            </div>
            <figure className={`${styles.reveal} relative`}>
              <figcaption className="sr-only">An example conversation with Dori</figcaption>
              <div className="space-y-3">
                <p className={`${styles.you} ml-auto max-w-sm px-4 py-3 text-base`}>It&apos;s Sunday and nothing is planned. What should I do?</p>
                <p className={`${styles.dori} max-w-md px-4 py-3 text-base leading-relaxed`}>
                  Your day is open until dinner at 7. You could call Maya, go for a 40-minute run, or tidy the kitchen before the week starts. Or just take it
                  easy. Want a few ideas for a slow afternoon?
                </p>
              </div>
              <div className="mt-6 flex flex-wrap items-end gap-x-1 gap-y-2">
                <DoriLive size={132} />
                <DoriLive size={132} character="kitten" />
                <p className={`${styles.marker} basis-full pl-2 text-lg text-muted sm:basis-auto sm:pb-6`}>Puppy or kitten, your pick.</p>
              </div>
            </figure>
          </div>
        </section>

        {/* How it works */}
        <section className="px-4 py-20 sm:px-6 sm:py-28">
          <div className="mx-auto max-w-6xl">
            <h2 className={`${styles.display} max-w-2xl text-4xl leading-[1.02] text-ink sm:text-5xl`}>Three steps from a full head to a clear week.</h2>
            <ol className={`${styles.rail} mt-14 grid gap-10 md:grid-cols-3 md:gap-8`}>
              {STEPS.map((s, i) => (
                <li key={s.title} className="relative">
                  <span className={styles.pin} aria-hidden>
                    {i + 1}
                  </span>
                  <h3 className={`${styles.display} mt-6 text-2xl text-ink`}>{s.title}</h3>
                  <p className="mt-2 max-w-xs leading-relaxed text-muted">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Booking */}
        <section className="bg-raised px-4 py-20 sm:px-6 sm:py-28">
          <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1.1fr_1fr]">
            <div className="order-2 flex justify-center lg:order-1">
              <BookingCard />
            </div>
            <div className="order-1 lg:order-2">
              <h2 className={`${styles.display} text-4xl leading-[1.02] text-ink sm:text-5xl`}>A booking link that knows when you are really free.</h2>
              <p className="mt-5 max-w-lg text-lg leading-relaxed text-muted">
                People pick from times that are open across every calendar you connect, so nothing gets double-booked. {APP_NAME} adds the Google Meet or
                Teams link, and the invite goes out from your own calendar.
              </p>
            </div>
          </div>
        </section>

        {/* Questions and trust */}
        <section className="px-4 py-20 sm:px-6 sm:py-28">
          <div className="mx-auto grid max-w-6xl gap-14 lg:grid-cols-[1fr_1.4fr]">
            <div>
              <h2 className={`${styles.display} text-4xl leading-[1.02] text-ink sm:text-5xl`}>Good to know</h2>
              <ul className="mt-8 space-y-4">
                {TRUST.map(({ Icon, text, href }) => (
                  <li key={text} className="flex items-center gap-3 text-ink">
                    <Icon size={19} strokeWidth={1.75} className="shrink-0 text-accent" aria-hidden />
                    {href ? (
                      <a href={href} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                        {text}
                      </a>
                    ) : (
                      <span>{text}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <div className="border-t border-line">
              {FAQ.map(([q, a]) => (
                <details key={q} className="group border-b border-line">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-lg font-medium text-ink">
                    {q}
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line text-faint transition-transform duration-200 group-open:rotate-45 group-open:border-accent group-open:text-accent" aria-hidden>
                      <Plus size={15} strokeWidth={2} />
                    </span>
                  </summary>
                  <p className="max-w-2xl pb-6 leading-relaxed text-muted">{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Close */}
        <section className="px-2 pb-6 sm:px-4 lg:px-6">
          <div className={`${styles.frame} mx-auto max-w-[1440px]`}>
            <div className={`${styles.board} ${styles.closing} text-center`}>
              <h2 className={`${styles.display} mx-auto max-w-3xl text-4xl leading-[1.02] text-ink sm:text-6xl`}>Start with one brain dump.</h2>
              <p className="mx-auto mt-5 max-w-md text-lg leading-relaxed text-muted">Tell {APP_NAME} what is on your mind and watch the week take shape.</p>
              <div className="mt-9 flex justify-center">{action(false)}</div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
