import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  doublePrecision,
  type AnyPgColumn,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export type TimeRange = { start: string; end: string }; // "09:00" - "17:00"
export type WeeklyHours = Record<string, TimeRange[]>; // keys "1".."7" (Mon..Sun, ISO weekday)
export type DateOverride = { date: string; ranges: TimeRange[] }; // empty ranges = unavailable all day

export type Provider = "google" | "microsoft";

export type LocationOption =
  | { type: "online" } // video call; the link (Google Meet or Microsoft Teams) comes from the booking calendar
  | { type: "in_person"; address: string }
  | { type: "phone_host_calls" } // invitee provides their number
  | { type: "phone_invitee_calls"; phone: string }
  | { type: "custom_link"; url: string; label?: string };

export type Question = {
  id: string;
  label: string;
  type: "text" | "textarea" | "phone" | "select";
  required: boolean;
  options?: string[];
};

export type BookingLocation = { type: LocationOption["type"]; value?: string };

export type Priority = "high" | "normal" | "low";
export type EventLocationKind = "video" | "in_person" | "unspecified";
export type LabelSource = "user" | "rule" | "ai";

/** Dashboard calendar display choices. */
export type CalendarPrefs = {
  // "kind" is Midore's own scheme: meetings neutral, planned work amber, bookings violet, at-risk work vermilion.
  colorBy: "kind" | "calendar" | "type" | "priority";
  v?: number; // 2 once prefs saved before "kind" existed have been moved onto it
  hidden: { categories: number[]; other: boolean; locations: EventLocationKind[]; priorities: Priority[] };
  // Calendars shown in the dashboard, per account id. An account with no entry shows its conflict
  // calendars plus the one bookings go to. Separate from what blocks availability (Settings).
  calendars?: Record<string, string[]>;
};

/** Dori settings a user chooses. */
export type DoriCharacter = "puppy" | "kitten";
export type DoriPrefs = {
  nickname: string; // how Dori greets you; empty = first name
  character?: DoriCharacter; // how Dori looks; default puppy
  briefAt?: string | null; // HH:mm: the morning brief (a notification and Dori's day plan); null = off
  language?: string | null; // Dori always answers in this language; null = the language of the last message
  style?: string | null; // how Dori talks, in the user's words ("shorter", "like a coach")
  dueHeadsUpDays?: number | null; // an alert this many days before every due date, at 9 am
  checkIns?: CheckIn[]; // times Dori speaks first besides the morning brief
  weatherPlace?: WeatherPlace | null; // the city the user said they live in, for the weather when no Home is saved
  weatherGuess?: WeatherPlace | null; // Dori's guess at the city (from time zone and connection), kept until the time zone changes
};

export type WeatherPlace = { name: string; lat: number; lng: number; tz?: string };

/** Dori speaking first at a set time: a notification, and on the web Dori opens with that conversation. */
export type CheckInTopic = "week_review" | "day_wrap" | "habits" | "custom";
export type CheckIn = {
  id: string; // short, stable
  weekdays: number[]; // 1 = Monday … 7 = Sunday; empty = every day
  at: string; // HH:mm in the user's time zone
  topic: CheckInTopic;
  text?: string; // for custom: what Dori should ask or do ("ask how the thesis is going")
};

/** Soft preferences shown to invitees; they never remove a slot. */
export type BookingPreferences = {
  locationIndex: number | null; // index into event_types.locations
  weekly: WeeklyHours | null; // preferred windows, in the schedule's time zone; null = no time preference
  note: string;
};

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    image: text("image"),
    username: text("username").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    headline: text("headline").notNull().default(""),
    welcome: text("welcome").notNull().default(""),
    brandColor: text("brand_color").notNull().default("#2563eb"),
    writeCalendarId: text("write_calendar_id").notNull().default("primary"),
    // Default calendar account that receives new bookings (event types can override it).
    writeAccountId: integer("write_account_id").references((): AnyPgColumn => calendarAccounts.id, { onDelete: "set null" }),
    calendarPrefs: jsonb("calendar_prefs").$type<CalendarPrefs>(),
    // When the user agreed to send event titles to the AI provider for categorisation; null = off.
    aiConsentAt: timestamp("ai_consent_at", { withTimezone: true }),
    // When the user turned on Dori, the assistant (sends tasks and the coming week's events to the model).
    doriConsentAt: timestamp("dori_consent_at", { withTimezone: true }),
    doriPrefs: jsonb("dori_prefs").$type<DoriPrefs>(),
    // Hours for planned work; null = the default availability schedule's hours.
    workHours: jsonb("work_hours").$type<WeeklyHours>(),
    // Set when tasks or the calendar changed, so the plan is recomputed on next use.
    planDirtyAt: timestamp("plan_dirty_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_username_idx").on(t.username)],
);

/**
 * A connected Google or Microsoft account. A user can connect several; signing in with any of them opens the
 * same Midore account. `refreshToken` is encrypted; null means access was revoked and the user must reconnect.
 * "primary" in calendar ids means the account's default calendar, whatever the provider calls it.
 */
export const calendarAccounts = pgTable(
  "calendar_accounts",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<Provider>().notNull(),
    providerAccountId: text("provider_account_id").notNull(), // Google `sub`; Microsoft `tid:oid`
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    refreshToken: text("refresh_token"), // encrypted
    scopes: text("scopes"),
    conflictCalendarIds: jsonb("conflict_calendar_ids").$type<string[]>().notNull().default(["primary"]),
    // Whether the provider can attach a video-call link to events (Teams needs a work or school account).
    onlineMeetings: boolean("online_meetings").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("calendar_accounts_provider_account_idx").on(t.provider, t.providerAccountId),
    index("calendar_accounts_user_idx").on(t.userId),
  ],
);

/**
 * The areas of a user's life: "Research", "Teaching", "Home". One list serves two purposes: it is the
 * "type" dimension the calendar is sorted into, and the top level that projects and tasks live under.
 * At most 20 per user.
 */
export const categories = pgTable(
  "categories",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    description: text("description").notNull().default(""), // one line on what belongs here
    defaultPriority: text("default_priority").$type<Priority>().notNull().default("normal"),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("categories_user_name_idx").on(t.userId, t.name)],
);

/** "If the title contains X, it's category Y (and priority Z)". First match wins, in position order. */
export const labelRules = pgTable(
  "label_rules",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pattern: text("pattern").notNull(), // matched case-insensitively as a substring of the title
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "cascade" }), // null = Other
    priority: text("priority").$type<Priority>(), // null = the category's default
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("label_rules_user_idx").on(t.userId)],
);

/**
 * A label on one calendar event (or a whole recurring series). Only the label and a hash of the title are
 * stored, never the title itself. A label from a rule or the AI is redone when the title changes; a label
 * the user set by hand sticks.
 */
export const eventLabels = pgTable(
  "event_labels",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => calendarAccounts.id, { onDelete: "cascade" }),
    eventKey: text("event_key").notNull(), // the series id for recurring events, else the event id
    titleHash: text("title_hash").notNull(),
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }), // null = Other
    priority: text("priority").$type<Priority>(), // null = the category's default
    source: text("source").$type<LabelSource>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("event_labels_account_event_idx").on(t.accountId, t.eventKey), index("event_labels_user_idx").on(t.userId)],
);

/** AI classification counters, for per-user and instance-wide caps. */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: text("day").notNull(), // YYYY-MM-DD (UTC)
    events: integer("events").notNull().default(0),
    requests: integer("requests").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    doriTurns: integer("dori_turns").notNull().default(0), // messages Dori answered
    voiceSeconds: integer("voice_seconds").notNull().default(0), // audio transcribed
    speechChars: integer("speech_chars").notNull().default(0), // characters read aloud
    meetingSeconds: integer("meeting_seconds").notNull().default(0), // meeting audio transcribed
  },
  (t) => [uniqueIndex("ai_usage_user_day_idx").on(t.userId, t.day)],
);

// --- Projects and tasks ------------------------------------------------------------------------------

export type ProjectStatus = "active" | "paused" | "done";
export type TaskKind = "task" | "reminder"; // a reminder is something to remember, never scheduled
export type TaskStatus = "open" | "good_enough" | "done" | "dropped";
export type TaskEnergy = "deep" | "light";
export type TaskLinkKind = "before" | "together"; // "from" finishes before "to" starts; or the two are done as one
// "daily", "weekly", "days:1,3,5", "nth:-1:5", "times:3" …; the grammar is in src/lib/tasks/repeat.ts.
export type TaskRepeat = string;
export type ChecklistItem = { text: string; done: boolean };

/** A bounded effort inside an area, e.g. "JIBS revision" under Research. */
export const projects = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }), // null = no area
    name: text("name").notNull(),
    notes: text("notes").notNull().default(""),
    status: text("status").$type<ProjectStatus>().notNull().default("active"),
    targetDate: text("target_date"), // YYYY-MM-DD, optional
    pausedUntil: text("paused_until"), // YYYY-MM-DD: a paused project counts as active again from this day
    pausedFrom: text("paused_from"), // YYYY-MM-DD: an active project pauses on this day (until pausedUntil, if set)
    position: integer("position").notNull().default(0),
    rank: integer("rank"), // importance the user gave (1 = most); ranked projects' work is planned first. null = unranked
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("projects_user_idx").on(t.userId)],
);

/**
 * One piece of work. "good_enough" means the job is mostly done and `residue` names the small part left;
 * it counts as complete, and the residue is collected in the Loose ends list.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
    // The area. Follows the project when there is one; set directly for a task that belongs to no project.
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    kind: text("kind").$type<TaskKind>().notNull().default("task"),
    status: text("status").$type<TaskStatus>().notNull().default("open"),
    residue: text("residue").notNull().default(""), // what is left when the task is "good enough"
    estimateMinutes: integer("estimate_minutes"), // null = unknown
    progress: integer("progress").notNull().default(0), // percent done, 0 to 100; the planner plans only what is left
    dueDate: text("due_date"), // YYYY-MM-DD, optional
    hardDeadline: boolean("hard_deadline").notNull().default(false), // a date that cannot move
    priority: text("priority").$type<Priority>().notNull().default("normal"),
    energy: text("energy").$type<TaskEnergy>(), // null = either
    people: jsonb("people").$type<string[]>().notNull().default([]), // who is involved
    repeat: text("repeat").$type<TaskRepeat>(), // completing a repeating task creates the next one
    seriesId: integer("series_id"), // the first occurrence of a repeating task; every later one points to it
    remindAt: timestamp("remind_at", { withTimezone: true }), // when to alert ("remind me at 6"); null = no alert
    deferCount: integer("defer_count").notNull().default(0), // times the due date was pushed later
    waitingOn: text("waiting_on"), // a person or thing this is waiting for; not planned until cleared
    checklist: jsonb("checklist").$type<ChecklistItem[]>().notNull().default([]), // small steps inside the task
    placeId: integer("place_id").references((): AnyPgColumn => places.id, { onDelete: "set null" }), // alert at a place (phones)
    placeOn: text("place_on").$type<PlaceTrigger>(), // arrive | leave
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("tasks_user_status_idx").on(t.userId, t.status), index("tasks_project_idx").on(t.projectId), index("tasks_remind_idx").on(t.remindAt)],
);

export type PlaceTrigger = "arrive" | "leave";

/**
 * Places the user saved (Home, Work) for alerts on arriving or leaving. The phone apps watch them; Dori sees only
 * their names, never where they are.
 */
export const places = pgTable(
  "places",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    radiusM: integer("radius_m").notNull().default(150),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("places_user_idx").on(t.userId)],
);
export type Place = typeof places.$inferSelect;

/**
 * Rules the user set up ("every time I finish a chapter, add a review with my supervisor"; "if the review isn't
 * done by Wednesday, drop it"). task_done runs when a matching task is finished; not_done_by runs once, in the
 * daily job after that day, if the task is still open.
 */
export type AutomationTrigger =
  | { on: "task_done"; projectId?: number | null; areaId?: number | null; titleHas?: string | null }
  | { on: "not_done_by"; taskId: number; day: string };
export type AutomationAction =
  | { do: "create_task"; title: string; projectId?: number | null; areaId?: number | null; dueInDays?: number | null; estimateMinutes?: number | null; priority?: Priority | null }
  | { do: "drop" }
  | { do: "set_priority"; priority: Priority }
  | { do: "move_due"; days: number }
  | { do: "remind"; text?: string | null }
  | { do: "tell_next" }; // task_done: Dori says what's next in the project
export const automations = pgTable(
  "automations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(), // the rule in the user's words, shown in Settings
    trigger: jsonb("trigger").$type<AutomationTrigger>().notNull(),
    action: jsonb("action").$type<AutomationAction>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    runs: integer("runs").notNull().default(0),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("automations_user_idx").on(t.userId)],
);
export type Automation = typeof automations.$inferSelect;

/** Ordering and grouping between tasks. */
export const taskLinks = pgTable(
  "task_links",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fromTaskId: integer("from_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    toTaskId: integer("to_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind").$type<TaskLinkKind>().notNull(),
  },
  (t) => [uniqueIndex("task_links_pair_idx").on(t.fromTaskId, t.toTaskId), index("task_links_user_idx").on(t.userId)],
);

// --- Planning ---------------------------------------------------------------------------------------

/** A piece of planned work placed in free time by the planner, or pinned there by the user. */
/** How a passed block went, as the user marked it. */
export type BlockOutcome = "done" | "good_enough" | "partly" | "not_done";
export type PlanBlock = { taskId: number; start: string; end: string; pinned: boolean }; // ISO instants
export type AtRisk = { taskId: number; reason: "late" | "unplaced"; finishesAt?: string };
export type PlanNotice = { at: string; text: string };

/** The current plan for a user, recomputed by code (never the model) whenever tasks or the calendar change. */
export const plans = pgTable("plans", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  blocks: jsonb("blocks").$type<PlanBlock[]>().notNull().default([]),
  atRisk: jsonb("at_risk").$type<AtRisk[]>().notNull().default([]),
  notices: jsonb("notices").$type<PlanNotice[]>().notNull().default([]), // "moved X because Y", for Dori to mention
  noticesSeenAt: timestamp("notices_seen_at", { withTimezone: true }),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Work the user fixed at a time ("work on X tomorrow 9 to 11"); the planner fits everything else around it. */
export const pinnedBlocks = pgTable(
  "pinned_blocks",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    start: timestamp("start", { withTimezone: true }).notNull(),
    end: timestamp("end", { withTimezone: true }).notNull(),
    // Once the block has passed: how it went, if the user said (calendar or widget), and the task's progress then.
    outcome: text("outcome").$type<BlockOutcome>(),
    progress: integer("progress"),
  },
  (t) => [index("pinned_blocks_user_idx").on(t.userId)],
);

/**
 * Something about one day ("not in the mood for writing", "keep Thursday and Friday for the grant"), or a
 * standing note when `day` is null. The structured fields steer the planner; `text` is for Dori.
 */
export const dayNotes = pgTable(
  "day_notes",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: text("day"), // YYYY-MM-DD in the user's time zone; null = always
    text: text("text").notNull(),
    avoidEnergy: text("avoid_energy").$type<TaskEnergy>(),
    skipTaskIds: jsonb("skip_task_ids").$type<number[]>().notNull().default([]),
    reserveForTaskIds: jsonb("reserve_for_task_ids").$type<number[]>().notNull().default([]), // only these that day
    maxWorkMinutes: integer("max_work_minutes"),
    weekday: integer("weekday"), // 1-7: a standing note for that weekday only (day must be null)
    // With both set, avoid/skip/reserve apply only between these times ("Wednesday mornings for writing").
    windowStart: text("window_start"), // HH:mm
    windowEnd: text("window_end"), // HH:mm
    startAfter: text("start_after"), // HH:mm: no planned work before this
    endBy: text("end_by"), // HH:mm: no planned work after this
    reserveForProjectIds: jsonb("reserve_for_project_ids").$type<number[]>().notNull().default([]),
    reserveForAreaIds: jsonb("reserve_for_area_ids").$type<number[]>().notNull().default([]),
    bufferMinutes: integer("buffer_minutes"), // keep this long free after each meeting
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("day_notes_user_day_idx").on(t.userId, t.day)],
);

// --- Dori, the assistant ----------------------------------------------------------------------------

export type DoriMood = "happy" | "thinking" | "busy" | "celebrating" | "concerned" | "sleeping";
export type DoriProposal = {
  areas: { name: string; description?: string }[];
  projects: { ref: string; name: string; area?: string; targetDate?: string | null; notes?: string }[];
  tasks: {
    title: string;
    project?: string; // a project ref from this proposal, or an existing project's name
    area?: string;
    kind?: TaskKind;
    estimateMinutes?: number | null;
    dueDate?: string | null;
    hardDeadline?: boolean;
    priority?: Priority;
    energy?: TaskEnergy | null;
    notes?: string;
    people?: string[];
    repeat?: TaskRepeat | null;
  }[];
  links: { before: number; after: number }[]; // indexes into tasks
  status: "pending" | "accepted" | "discarded";
};
export type DoriCard =
  | { kind: "emails"; items: { label: string; href: string; count: number }[] }
  | {
      kind: "event"; title: string; start: string; end: string; attendees: string[]; status: "pending" | "added" | "dismissed";
      onlineMeeting?: boolean; accountId?: number; calendarId?: string; calendarLabel?: string; location?: string; description?: string;
      recurrence?: { freq: "daily" | "weekly" | "monthly" | "yearly"; interval?: number; byWeekday?: number[]; count?: number; until?: string }; repeatLabel?: string;
    }
  | {
      kind: "event_change"; action: "move" | "delete"; title: string; accountId: number; calendarId: string; eventId: string;
      start: string; end: string; newStart?: string; newEnd?: string; status: "pending" | "done" | "dismissed";
    }
  | { kind: "delete_area"; id: number; name: string; status: "pending" | "done" | "dismissed" }
  | { kind: "booking_cancel"; uid: string; title: string; who: string; start: string; end: string; reason: string; status: "pending" | "done" | "dismissed" }
  | {
      kind: "rsvp"; response: "accepted" | "declined" | "tentative"; comment: string; title: string; accountId: number; calendarId: string; eventId: string;
      start: string; end: string; status: "pending" | "done" | "dismissed";
    }
  | { kind: "slots"; items: { start: string; end: string; shifts: string[] }[] };
export type DoriMeta = {
  lang?: string;
  mood?: DoriMood;
  actions?: string[]; // what Dori changed, in words
  undoable?: boolean;
  undone?: boolean;
  proposal?: DoriProposal;
  cards?: DoriCard[];
  credits?: { text: string; href: string }[]; // data sources shown under the reply (weather, maps)
  fromRule?: number; // posted by an automation ("tell me what's next"), not in reply to the user
};

export const doriMessages = pgTable(
  "dori_messages",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    meta: jsonb("meta").$type<DoriMeta>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dori_messages_user_idx").on(t.userId, t.id)],
);

// --- Meeting notes ----------------------------------------------------------------------------------------

export type MeetingStatus = "recording" | "done";
export type MeetingAction = { text: string; who: string; due?: string | null; taskId?: number | null };
/** One key point: what happened, where in the transcript ("12:30"), and whether the discussion turned there. */
export type MeetingPoint = { text: string; at: string | null; turn: boolean };
export type MeetingSummary = {
  summary: string[]; // the key points as plain text (older meetings have only this)
  points?: MeetingPoint[];
  decisions: string[];
  actions: MeetingAction[];
  live?: boolean; // key points so far, while the meeting is still going
};

/**
 * A meeting the user recorded or took notes in. Audio is transcribed a minute at a time and never stored; the
 * transcript ("[mm:ss] text" lines), the user's own notes and Dori's summary are kept until the user deletes them.
 */
export const meetings = pgTable(
  "meetings",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    eventKey: text("event_key"), // "<accountId>:<event key>" when it belongs to a calendar event
    status: text("status").$type<MeetingStatus>().notNull().default("recording"),
    recorded: boolean("recorded").notNull().default(true), // false = notes only, no audio
    transcript: text("transcript").notNull().default(""),
    notes: text("notes").notNull().default(""),
    summary: jsonb("summary").$type<MeetingSummary>(),
    seconds: integer("seconds").notNull().default(0), // audio transcribed
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("meetings_user_idx").on(t.userId, t.startedAt)],
);
export type Meeting = typeof meetings.$inferSelect;

/** How to reverse one change Dori made. Applied newest first when the user presses Undo. */
export type UndoOp =
  | { op: "deleteTask"; id: number }
  | { op: "restoreTask"; row: Record<string, unknown>; links: Record<string, unknown>[] }
  | { op: "patchTask"; id: number; fields: Record<string, unknown> }
  | { op: "deleteProject"; id: number }
  | { op: "patchProject"; id: number; fields: Record<string, unknown> }
  | { op: "deleteCategory"; id: number }
  | { op: "deleteLink"; id: number }
  | { op: "deleteNote"; id: number }
  | { op: "restoreNote"; row: Record<string, unknown> }
  | { op: "deletePinned"; id: number }
  | { op: "restorePinned"; row: Record<string, unknown> }
  | { op: "setWorkHours"; weekly: WeeklyHours | null }
  | { op: "restoreProject"; row: Record<string, unknown>; tasks: Record<string, unknown>[]; links: Record<string, unknown>[] }
  | { op: "patchCategory"; id: number; fields: Record<string, unknown> }
  | { op: "restoreCategory"; row: Record<string, unknown>; taskIds: number[]; projectIds: number[] }
  | { op: "patchUser"; fields: { doriPrefs?: DoriPrefs | null; timezone?: string } }
  | { op: "patchEventType"; id: number; fields: Record<string, unknown> }
  | { op: "patchSchedule"; id: number; fields: Record<string, unknown> }
  | { op: "deleteEventType"; id: number }
  | { op: "deleteSchedule"; id: number }
  | { op: "deleteAutomation"; id: number }
  | { op: "restoreAutomation"; row: Record<string, unknown> };

export const doriActions = pgTable(
  "dori_actions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageId: integer("message_id")
      .notNull()
      .references(() => doriMessages.id, { onDelete: "cascade" }),
    undo: jsonb("undo").$type<UndoOp[]>().notNull(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dori_actions_message_idx").on(t.messageId)],
);

/** Push-notification channels on connected calendars, so new or changed events re-run the planner. */
export const calendarWatches = pgTable(
  "calendar_watches",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => calendarAccounts.id, { onDelete: "cascade" }),
    calendarId: text("calendar_id").notNull(),
    channelId: text("channel_id").notNull(), // Google channel id, or Microsoft subscription id
    resourceId: text("resource_id"), // Google only, needed to stop the channel
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("calendar_watches_channel_idx").on(t.channelId), index("calendar_watches_account_idx").on(t.accountId)],
);

export const schedules = pgTable(
  "schedules",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    timezone: text("timezone").notNull(),
    weekly: jsonb("weekly").$type<WeeklyHours>().notNull(),
    overrides: jsonb("overrides").$type<DateOverride[]>().notNull().default([]),
    isDefault: boolean("is_default").notNull().default(false),
  },
  (t) => [index("schedules_user_idx").on(t.userId)],
);

export const eventTypes = pgTable(
  "event_types",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    durations: jsonb("durations").$type<number[]>().notNull().default([30]),
    locations: jsonb("locations").$type<LocationOption[]>().notNull().default([{ type: "online" }]),
    color: text("color").notNull().default("#2563eb"),
    scheduleId: integer("schedule_id").references(() => schedules.id, { onDelete: "set null" }),
    // Where bookings of this type go; null means the user's default account and calendar.
    writeAccountId: integer("write_account_id").references(() => calendarAccounts.id, { onDelete: "set null" }),
    writeCalendarId: text("write_calendar_id"),
    preferences: jsonb("preferences").$type<BookingPreferences>(),
    bufferBefore: integer("buffer_before").notNull().default(0),
    bufferAfter: integer("buffer_after").notNull().default(0),
    minNotice: integer("min_notice").notNull().default(240), // minutes
    maxDaysAhead: integer("max_days_ahead").notNull().default(60),
    slotInterval: integer("slot_interval"), // minutes; null = use duration
    dailyLimit: integer("daily_limit"), // null = unlimited
    seats: integer("seats").notNull().default(1), // >1 = group event
    questions: jsonb("questions").$type<Question[]>().notNull().default([]),
    hidden: boolean("hidden").notNull().default(false), // secret: not listed on profile
    active: boolean("active").notNull().default(true),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("event_types_user_slug_idx").on(t.userId, t.slug)],
);

export const bookings = pgTable(
  "bookings",
  {
    id: serial("id").primaryKey(),
    uid: text("uid").notNull(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventTypeId: integer("event_type_id").references(() => eventTypes.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    start: timestamp("start", { withTimezone: true }).notNull(),
    end: timestamp("end", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    guests: jsonb("guests").$type<string[]>().notNull().default([]),
    notes: text("notes").notNull().default(""),
    answers: jsonb("answers").$type<Record<string, string>>().notNull().default({}),
    location: jsonb("location").$type<BookingLocation>().notNull(),
    meetLink: text("meet_link"), // Google Meet or Microsoft Teams join link
    accountId: integer("account_id").references(() => calendarAccounts.id, { onDelete: "set null" }),
    calendarId: text("calendar_id"),
    eventId: text("event_id"), // the event's id at the provider
    status: text("status").$type<"confirmed" | "cancelled">().notNull().default("confirmed"),
    cancelReason: text("cancel_reason"),
    cancelledBy: text("cancelled_by").$type<"host" | "invitee">(),
    rescheduledFrom: text("rescheduled_from"),
    // One-on-one bookings can't overlap; the bookings_no_overlap exclusion constraint (migration 0001)
    // enforces it in the database. Group bookings share a time slot, so they are not exclusive.
    exclusive: boolean("exclusive").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("bookings_uid_idx").on(t.uid),
    index("bookings_user_start_idx").on(t.userId, t.start),
  ],
);

// Fixed-window request counters for the public endpoints (see src/lib/rate-limit.ts).
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});

// Desktop and phone apps (the Tauri apps in native/). A device signs in once through the browser and then calls
// /api/v1 with a bearer token. Only a SHA-256 hash of the token is stored.
export type DevicePlatform = "macos" | "windows" | "linux" | "ios" | "android";
export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    platform: text("platform").$type<DevicePlatform>().notNull(),
    name: text("name").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("device_tokens_hash_idx").on(t.tokenHash), index("device_tokens_user_idx").on(t.userId)],
);

// One-time codes, valid for a few minutes: "connect" codes carry a signed-in browser session to an app
// (exchanged for a device token), "webview" codes carry a device token into the app's web view as a session.
export const nativeCodes = pgTable("native_codes", {
  codeHash: text("code_hash").primaryKey(),
  kind: text("kind").$type<"connect" | "webview">().notNull(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  platform: text("platform").$type<DevicePlatform>().notNull(),
  name: text("name").notNull().default(""),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type DeviceToken = typeof deviceTokens.$inferSelect;
export type User = typeof users.$inferSelect;
export type CalendarAccount = typeof calendarAccounts.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskLink = typeof taskLinks.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type PinnedBlock = typeof pinnedBlocks.$inferSelect;
export type DayNote = typeof dayNotes.$inferSelect;
export type DoriMessage = typeof doriMessages.$inferSelect;
export type LabelRule = typeof labelRules.$inferSelect;
export type EventLabel = typeof eventLabels.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
export type EventType = typeof eventTypes.$inferSelect;
export type Booking = typeof bookings.$inferSelect;

// Sign-in methods that are not calendar accounts. Sign in with Apple identifies a person but gives no calendar,
// so it lives here instead of calendar_accounts; the user connects a Google or Microsoft calendar afterwards.
export type LoginProvider = "apple";
export const loginIdentities = pgTable(
  "login_identities",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<LoginProvider>().notNull(),
    subject: text("subject").notNull(), // Apple's stable user id (`sub`)
    email: text("email").notNull().default(""), // may be an Apple private relay address
    privateEmail: boolean("private_email").notNull().default(false),
    // Encrypted. Kept only to revoke Midore's access at Apple when the account is deleted.
    refreshToken: text("refresh_token"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("login_identities_provider_subject_idx").on(t.provider, t.subject), index("login_identities_user_idx").on(t.userId)],
);
export type LoginIdentity = typeof loginIdentities.$inferSelect;
