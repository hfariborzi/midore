# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Busy people with full calendars, usually professionals who take a lot of meetings, juggling work, deadlines and the rest of life: friends, family, workouts, chores and rest. They usually already use Google Calendar or Outlook, a separate to-do list, and a booking link tool. Their job: get a week, and a life, that actually works, without manually shuffling things into gaps and without double-booking.

## Product Purpose

Midore is a calendar that plans your week. It brings three things people usually pay for separately into one place: a booking page (like Calendly), a task list with projects, and a planner that fits tasks into the free time between meetings. An optional assistant, Dori, takes a brain dump by text or voice and turns it into tasks and a plan. Midore manages life, not only work: on a free Sunday Dori can suggest catching up with friends, a workout, tidying up, or simply resting, and offer ideas for how to unwind. Success: a visitor connects a calendar, empties their head once, and sees a realistic, balanced week.

## Positioning

- Planning that never touches meetings: the planner is plain, deterministic code that places only the user's own work into gaps, in deadline order. It never moves or deletes events on its own (Dori can offer to move or delete the user's own events with no other guests, after they confirm); blocks can be pinned and Dori's changes undone.
- Booking, tasks and planning in one product, on top of the calendars people already have (Google and Microsoft, any number of accounts).
- AI is optional and off by default; when on, it runs on providers that keep no copy of data and never train on it.

## Operating Context

Visitors arrive from colleagues' recommendations, comparison searches and launch platforms. They sign in with Google or Microsoft, grant calendar access, and land on a one-screen app: the calendar is always visible; tasks, booking and settings open over it; Dori docks beside it. Invitees use public booking pages at midore.app/{username}/{slug}.

## Capabilities and Constraints

- Shipped: booking pages, multi-account Google and Microsoft calendars, calendar (week/day; month with a day list on phones), categories, tasks and projects with "good enough" and partial progress, deterministic planner, Dori (text and voice, puppy or kitten; reminders at a time or a place, habits, check-ins such as a Sunday review, rules like "every time I finish a chapter, add a review"), calendar push sync. Native apps (Tauri 2) for Mac and Linux, and iPhone and Android builds, with widgets, a menu bar calendar, quick add from anywhere, on-device reminders, an iPhone Live Activity and Share to Midore.
- Not built: billing and paid plans, emails sent by Midore, server push, data export, team features, store listings for the apps, a Windows build. Microsoft sign-in is built but not enabled in production.
- Stack: Next.js 16 (App Router), React 19, Tailwind 4, hosted on Vercel.
- Google sign-in buttons must follow Google's branding rules.

## Brand Commitments

- Name: Midore, said "mee-doh-ray", like the notes mi, do, re. Always written "Midore"; the wordmark is lowercase "midore".
- Logo (October 12, 2026): a small vermilion block above a large one with a notch cut into its base; source files in `docs/private/design/logo/2026-10-12/`, drawn in `src/components/Logo.tsx`. Always vermilion #E11D48, shown next to the lowercase "midore" wordmark.
- Primary colour chosen by the owner: Kyoto vermilion (#e11d48).
- Dori is the in-app assistant: a puppy or a kitten, always called "Dori, your Midore assistant", never "Dory". Real stills and transparent idle videos are in `public/dori/`.
- Wording is general, not aimed at academics.

## Evidence on Hand

- Real product: the calendar, planner and Dori in this repo; Dori artwork and idle videos in `public/dori/`.
- Facts that can be stated: calendar access verified by Google; AI providers keep no copy and never train on data; the code is public on GitHub; made in Canada; booking, tasks, projects and the planner are free.
- None yet: customers, testimonials, usage numbers, press, pricing. Do not invent them.

## Product Principles

1. The calendar the user already has stays the source of truth; Midore never moves other people's meetings.
2. Life, not just work: rest, people and personal time are first-class plans, never leftovers.
3. One input, one workable week: the brain dump is the moment of value.
4. AI is a helper the user switches on, never a requirement.
5. Say only what is true today; no claims about features or plans that do not exist.
