import { calendar as calendarApi, type calendar_v3 } from "@googleapis/calendar";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { eq } from "drizzle-orm";
import { db, calendarAccounts, type CalendarAccount } from "@/db";
import { decrypt } from "../crypto";
import { appUrl } from "../config";
import { logWarn } from "../log";
import {
  CalendarNotConnectedError,
  type AuthProvider,
  type AuthUrlOptions,
  type CalendarEvent,
  type CalendarListItem,
  type CalendarProvider,
  type Interval,
  type NewEvent,
  type ProviderIdentity,
} from "./types";
import { toRRule } from "./recurrence";

// The narrowest Calendar scopes that cover what the app does (Google verification asks for minimal scopes).
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events", // list, create, update and delete events
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly", // list calendars for the settings page
  "https://www.googleapis.com/auth/calendar.freebusy", // check busy times for availability
];
const SCOPES = ["openid", "email", "profile", ...GOOGLE_CALENDAR_SCOPES];

/** Google's consent screen lets people untick individual scopes; calendar features need all of them. */
export function hasGoogleCalendarScopes(granted: string) {
  const set = new Set(granted.split(/\s+/));
  return GOOGLE_CALENDAR_SCOPES.every((s) => set.has(s));
}

function oauthClient(origin?: string) {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set");
  return new OAuth2Client({ clientId: id, clientSecret: secret, redirectUri: `${appUrl(origin)}/api/auth/google/callback` });
}

export const googleAuth: AuthProvider = {
  provider: "google",
  enabled: () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  authUrl(o: AuthUrlOptions) {
    return oauthClient(o.origin).generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      state: o.state,
      include_granted_scopes: true,
      prompt: o.forceConsent ? "consent" : "select_account",
      login_hint: o.loginHint,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: o.codeChallenge,
      // generateAuthUrl forwards unknown params; nonce is checked against the ID token in exchangeCode.
      ...({ nonce: o.nonce } as object),
    });
  },
  async exchangeCode(code, codeVerifier, nonce, origin): Promise<ProviderIdentity> {
    const client = oauthClient(origin);
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.id_token) throw new Error("Google did not return an ID token");
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email) throw new Error("Google ID token is missing the account identity");
    if (p.nonce !== nonce) throw new Error("OAuth nonce mismatch");
    const scopes = tokens.scope ?? "";
    return {
      providerAccountId: p.sub,
      email: p.email,
      emailVerified: !!p.email_verified,
      name: p.name ?? "",
      picture: p.picture ?? null,
      refreshToken: tokens.refresh_token ?? null,
      scopes,
      hasCalendarScopes: hasGoogleCalendarScopes(scopes),
      onlineMeetings: true,
    };
  },
};

// Reuse one OAuth client per account and token while the server instance stays warm, so its access token is
// cached instead of being refreshed before every API call.
const clients = new Map<string, OAuth2Client>();

function calendarFor(account: CalendarAccount): calendar_v3.Calendar {
  if (!account.refreshToken) throw new CalendarNotConnectedError(account);
  const key = `${account.id}:${account.refreshToken}`;
  let client = clients.get(key);
  if (!client) {
    let refreshToken: string;
    try {
      refreshToken = decrypt(account.refreshToken);
    } catch {
      // Unreadable (e.g. AUTH_SECRET changed): useless, so drop it and ask the user to reconnect.
      void db.update(calendarAccounts).set({ refreshToken: null }).where(eq(calendarAccounts.id, account.id)).catch(() => {});
      throw new CalendarNotConnectedError(account);
    }
    if (clients.size > 500) clients.clear();
    client = oauthClient();
    client.setCredentials({ refresh_token: refreshToken });
    clients.set(key, client);
  }
  return calendarApi({ version: "v3", auth: client });
}

// If Google says the grant is dead (user revoked access), forget the token so the UI asks to reconnect.
async function guard<T>(account: CalendarAccount, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = String((err as { message?: string })?.message ?? err);
    if (msg.includes("invalid_grant")) {
      await db.update(calendarAccounts).set({ refreshToken: null }).where(eq(calendarAccounts.id, account.id));
      throw new CalendarNotConnectedError(account);
    }
    throw err;
  }
}

function statusCode(err: unknown) {
  return (err as { code?: number; status?: number })?.code ?? (err as { status?: number })?.status;
}

export const googleCalendar: CalendarProvider = {
  provider: "google",

  async getBusy(account, calendarIds, timeMin, timeMax): Promise<Interval[]> {
    if (!calendarIds.length) return [];
    const cal = calendarFor(account);
    const res = await guard(account, () =>
      cal.freebusy.query({
        requestBody: {
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          items: calendarIds.map((id) => ({ id })),
        },
      }),
    );
    const out: Interval[] = [];
    for (const c of Object.values(res.data.calendars ?? {})) {
      for (const b of c.busy ?? []) {
        if (b.start && b.end) out.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
      }
    }
    return out;
  },

  async listCalendars(account): Promise<CalendarListItem[]> {
    const cal = calendarFor(account);
    const res = await guard(account, () => cal.calendarList.list({ maxResults: 250 }));
    return (res.data.items ?? [])
      .filter((c) => c.id)
      .map((c) => ({
        id: c.primary ? "primary" : c.id!,
        summary: c.summaryOverride || c.summary || c.id!,
        primary: !!c.primary,
        color: c.backgroundColor || "#7c3aed",
        canWrite: c.accessRole === "owner" || c.accessRole === "writer",
        canReadEvents: c.accessRole !== "freeBusyReader",
      }))
      .sort((a, b) => Number(b.primary) - Number(a.primary) || a.summary.localeCompare(b.summary));
  },

  async listEvents(account, calendars, timeMin, timeMax): Promise<CalendarEvent[]> {
    const cal = calendarFor(account);
    const results = await Promise.all(
      calendars
        .filter((c) => c.canReadEvents)
        .map(async (c) => {
          const res = await guard(account, () =>
            cal.events.list({
              calendarId: c.id,
              timeMin: timeMin.toISOString(),
              timeMax: timeMax.toISOString(),
              singleEvents: true,
              orderBy: "startTime",
              maxResults: 2500,
            }),
          ).catch((err) => {
            // One unreadable calendar shouldn't blank the whole view; a revoked grant still propagates.
            if (err instanceof CalendarNotConnectedError) throw err;
            logWarn("google", `could not list events for calendar ${c.id} of account ${account.id}: ${(err as Error).message}`);
            return { data: { items: [] as calendar_v3.Schema$Event[] } };
          });
          return (res.data.items ?? [])
            .filter((e) => e.status !== "cancelled" && e.id)
            .map<CalendarEvent>((e) => ({
              id: e.id!,
              seriesId: e.recurringEventId ?? undefined,
              accountId: account.id,
              calendarId: c.id,
              calendarName: c.summary,
              title: e.summary || "(No title)",
              start: e.start?.dateTime || e.start?.date || "",
              end: e.end?.dateTime || e.end?.date || "",
              allDay: !e.start?.dateTime,
              color: c.color,
              location: e.location ?? undefined,
              meetLink: e.hangoutLink ?? undefined,
              htmlLink: e.htmlLink ?? undefined,
              description: e.description ?? undefined,
              attendees: (e.attendees ?? [])
                .filter((a) => a.email)
                .map((a) => ({ email: a.email!, name: a.displayName ?? undefined, status: a.responseStatus ?? undefined })),
              canEdit: c.canWrite,
            }));
        }),
    );
    return results.flat();
  },

  async createEvent(account, calendarId, ev: NewEvent) {
    const cal = calendarFor(account);
    const res = await guard(account, () =>
      cal.events.insert({
        calendarId,
        conferenceDataVersion: 1,
        sendUpdates: "all",
        requestBody: {
          summary: ev.summary,
          description: ev.description,
          location: ev.location,
          start: { dateTime: ev.start.toISOString(), timeZone: ev.timeZone },
          end: { dateTime: ev.end.toISOString(), timeZone: ev.timeZone },
          attendees: ev.attendees,
          guestsCanModify: false,
          extendedProperties: ev.privateProps ? { private: ev.privateProps } : undefined,
          recurrence: ev.recurrence ? [toRRule(ev.recurrence)] : undefined,
          conferenceData: ev.onlineMeeting
            ? { createRequest: { requestId: ev.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } }
            : undefined,
        },
      }),
    );
    return { id: res.data.id!, meetLink: res.data.hangoutLink ?? null, htmlLink: res.data.htmlLink ?? null };
  },

  async getEvent(account, calendarId, eventId) {
    const cal = calendarFor(account);
    try {
      const res = await guard(account, () => cal.events.get({ calendarId, eventId }));
      return {
        cancelled: res.data.status === "cancelled",
        attendees: (res.data.attendees ?? [])
          .filter((a) => a.email)
          .map((a) => ({ email: a.email!, name: a.displayName ?? undefined, status: a.responseStatus ?? undefined })),
      };
    } catch (err) {
      const code = statusCode(err);
      if (code === 404 || code === 410) return null;
      throw err;
    }
  },

  async setAttendees(account, calendarId, eventId, attendees) {
    const cal = calendarFor(account);
    await guard(account, () =>
      cal.events.patch({
        calendarId,
        eventId,
        sendUpdates: "all",
        conferenceDataVersion: 1,
        requestBody: { attendees: attendees.map((a) => ({ email: a.email, displayName: a.name })) },
      }),
    );
  },

  async moveEvent(account, calendarId, eventId, start, end, timeZone) {
    const cal = calendarFor(account);
    await guard(account, () =>
      cal.events.patch({
        calendarId,
        eventId,
        sendUpdates: "all",
        conferenceDataVersion: 1,
        requestBody: {
          start: { dateTime: start.toISOString(), timeZone },
          end: { dateTime: end.toISOString(), timeZone },
        },
      }),
    );
  },

  async deleteEvent(account, calendarId, eventId) {
    const cal = calendarFor(account);
    try {
      await guard(account, () => cal.events.delete({ calendarId, eventId, sendUpdates: "all" }));
    } catch (err) {
      const code = statusCode(err);
      if (code === 404 || code === 410) return; // already gone
      throw err;
    }
  },

  async revoke(refreshToken) {
    try {
      await oauthClient().revokeToken(refreshToken);
    } catch {
      // Token may already be invalid; nothing else to do.
    }
  },

  // Push notifications use the calendar.events scope the app already has; channels last at most a week.
  async watch(account, calendarId, address, channelId, token) {
    const cal = calendarFor(account);
    const res = await guard(account, () =>
      cal.events.watch({ calendarId, requestBody: { id: channelId, type: "web_hook", address, token, params: { ttl: String(7 * 86_400) } } }),
    );
    const expiration = Number(res.data.expiration);
    return { channelId, resourceId: res.data.resourceId ?? null, expiresAt: new Date(Number.isFinite(expiration) ? expiration : Date.now() + 6 * 86_400_000) };
  },

  async unwatch(account, channelId, resourceId) {
    if (!resourceId) return;
    try {
      await guard(account, () => calendarFor(account).channels.stop({ requestBody: { id: channelId, resourceId } }));
    } catch {
      // Already expired or stopped.
    }
  },
};
