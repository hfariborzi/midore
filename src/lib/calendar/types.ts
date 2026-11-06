import type { CalendarAccount, Provider } from "@/db/schema";
import type { Recurrence } from "./recurrence";

/** Thrown when an account's access was revoked or expired. The user has to reconnect it in Settings. */
export class CalendarNotConnectedError extends Error {
  constructor(public readonly account?: Pick<CalendarAccount, "id" | "email" | "provider">) {
    super(account ? `${account.email} needs to be reconnected` : "No calendar is connected");
  }
}

export type Interval = { start: number; end: number }; // epoch ms

export type CalendarListItem = {
  id: string; // "primary" for the account's default calendar
  summary: string;
  primary: boolean;
  color: string;
  canWrite: boolean;
  canReadEvents: boolean; // false for calendars shared as "see only free/busy"
};

export type Attendee = { email: string; name?: string; status?: string };

export type CalendarEvent = {
  id: string;
  seriesId?: string; // set for instances of a recurring event
  accountId: number;
  calendarId: string;
  calendarName?: string;
  title: string;
  start: string; // ISO date-time, or ISO date for all-day events
  end: string;
  allDay: boolean;
  color: string;
  location?: string;
  meetLink?: string;
  htmlLink?: string;
  description?: string;
  attendees: Attendee[];
  organizer?: string; // name, or email when there is no name
  myResponse?: string; // the user's own answer, when they were invited: needsAction | accepted | declined | tentative | organizer
  canEdit: boolean;
};

export type NewEvent = {
  requestId: string; // idempotency key for conference creation
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  timeZone: string;
  attendees: { email: string; displayName?: string }[];
  onlineMeeting: boolean; // attach a Google Meet / Microsoft Teams link
  privateProps?: Record<string, string>;
  recurrence?: Recurrence;
};

export type { Recurrence } from "./recurrence";

export type CreatedEvent = { id: string; meetLink: string | null; htmlLink: string | null };

export type RsvpResponse = "accepted" | "declined" | "tentative";

export type EventSnapshot = { attendees: Attendee[]; cancelled: boolean };

/** What every calendar provider must implement. All methods take the connected account they act on. */
export interface CalendarProvider {
  readonly provider: Provider;
  /** Busy intervals across the given calendars. */
  getBusy(account: CalendarAccount, calendarIds: string[], timeMin: Date, timeMax: Date, tz: string): Promise<Interval[]>;
  listCalendars(account: CalendarAccount): Promise<CalendarListItem[]>;
  listEvents(account: CalendarAccount, calendars: CalendarListItem[], timeMin: Date, timeMax: Date): Promise<CalendarEvent[]>;
  createEvent(account: CalendarAccount, calendarId: string, ev: NewEvent): Promise<CreatedEvent>;
  /** null when the event no longer exists. */
  getEvent(account: CalendarAccount, calendarId: string, eventId: string): Promise<EventSnapshot | null>;
  setAttendees(account: CalendarAccount, calendarId: string, eventId: string, attendees: Attendee[]): Promise<void>;
  moveEvent(account: CalendarAccount, calendarId: string, eventId: string, start: Date, end: Date, timeZone: string): Promise<void>;
  deleteEvent(account: CalendarAccount, calendarId: string, eventId: string): Promise<void>;
  /** Answer an invitation the account was sent; the organizer is told. Throws when the account isn't a guest. */
  respond(account: CalendarAccount, calendarId: string, eventId: string, response: RsvpResponse, comment?: string): Promise<void>;
  /** Best effort: tell the provider to forget our access. */
  revoke(refreshToken: string): Promise<void>;
  /** Ask the provider to call `address` when events on this calendar change. */
  watch(account: CalendarAccount, calendarId: string, address: string, channelId: string, token: string): Promise<{ channelId: string; resourceId: string | null; expiresAt: Date }>;
  /** Stop a watch created by `watch`. Best effort. */
  unwatch(account: CalendarAccount, channelId: string, resourceId: string | null): Promise<void>;
}

/** What an OAuth sign-in or connect flow learns about the account. */
export type ProviderIdentity = {
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture: string | null;
  refreshToken: string | null; // null when the provider didn't issue one this time
  scopes: string;
  hasCalendarScopes: boolean;
  onlineMeetings: boolean;
};

export type AuthUrlOptions = {
  state: string;
  nonce: string;
  codeChallenge: string;
  origin: string;
  forceConsent: boolean;
  loginHint?: string;
};

export interface AuthProvider {
  readonly provider: Provider;
  enabled(): boolean;
  authUrl(opts: AuthUrlOptions): string;
  exchangeCode(code: string, codeVerifier: string, nonce: string, origin: string): Promise<ProviderIdentity>;
}
