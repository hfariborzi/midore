import { createRemoteJWKSet, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { db, calendarAccounts, type CalendarAccount } from "@/db";
import { decrypt, encrypt } from "../crypto";
import { appUrl } from "../config";
import { logWarn } from "../log";
import {
  allDayDate,
  busyFromEvents,
  calendarColor,
  calendarPath,
  CONSUMER_TENANT,
  hasMicrosoftCalendarScopes,
  isDeadGrant,
  mapAttendees,
  MICROSOFT_SCOPES,
  parseGraphUtc,
  toGraphAttendees,
  toGraphDateTime,
  toGraphRecurrence,
  type GraphAttendee,
  type GraphDateTime,
  type GraphEventLite,
} from "./microsoft-graph";
import {
  CalendarNotConnectedError,
  type AuthProvider,
  type AuthUrlOptions,
  type CalendarEvent,
  type CalendarListItem,
  type CalendarProvider,
  type NewEvent,
  type ProviderIdentity,
} from "./types";

const AUTHORITY = "https://login.microsoftonline.com/common";
const GRAPH = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 15_000;

function clientCredentials() {
  const id = process.env.MICROSOFT_CLIENT_ID;
  const secret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!id || !secret) throw new Error("MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET are not set");
  return { id, secret };
}

const redirectUri = (origin?: string) => `${appUrl(origin)}/api/auth/microsoft/callback`;

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
  error_codes?: number[];
};

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const { id, secret } = clientCredentials();
  const res = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...form, client_id: id, client_secret: secret }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return (await res.json()) as TokenResponse;
}

// Signing keys for ID tokens; jose caches them between calls.
const jwks = createRemoteJWKSet(new URL(`${AUTHORITY}/discovery/v2.0/keys`));

export const microsoftAuth: AuthProvider = {
  provider: "microsoft",
  enabled: () => !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET),
  authUrl(o: AuthUrlOptions) {
    const q = new URLSearchParams({
      client_id: clientCredentials().id,
      response_type: "code",
      redirect_uri: redirectUri(o.origin),
      response_mode: "query",
      scope: MICROSOFT_SCOPES.join(" "),
      state: o.state,
      nonce: o.nonce,
      code_challenge: o.codeChallenge,
      code_challenge_method: "S256",
      prompt: o.forceConsent ? "consent" : "select_account",
    });
    if (o.loginHint) q.set("login_hint", o.loginHint);
    return `${AUTHORITY}/oauth2/v2.0/authorize?${q}`;
  },
  async exchangeCode(code, codeVerifier, nonce, origin): Promise<ProviderIdentity> {
    const t = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(origin),
      code_verifier: codeVerifier,
      scope: MICROSOFT_SCOPES.join(" "),
    });
    if (t.error || !t.id_token) throw new Error(`Microsoft token exchange failed: ${t.error ?? "no id_token"}`);

    // Verify the ID token: signature against Microsoft's keys, our client as audience, a tenant-specific issuer.
    const { payload } = await jwtVerify(t.id_token, jwks, { audience: clientCredentials().id });
    const tid = typeof payload.tid === "string" ? payload.tid : "";
    const oid = typeof payload.oid === "string" ? payload.oid : "";
    if (!tid || !oid) throw new Error("Microsoft ID token is missing the account identity");
    if (payload.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) throw new Error("Unexpected ID token issuer");
    if (payload.nonce !== nonce) throw new Error("OAuth nonce mismatch");

    const email = (typeof payload.email === "string" && payload.email) || (typeof payload.preferred_username === "string" ? payload.preferred_username : "");
    if (!email.includes("@")) throw new Error("Microsoft account has no email address");
    const scopes = t.scope ?? "";
    return {
      providerAccountId: `${tid}:${oid}`,
      email,
      // Microsoft only vouches for the address when the tenant verified the domain (xms_edov).
      emailVerified: payload.xms_edov === true || payload.xms_edov === "1",
      name: typeof payload.name === "string" ? payload.name : "",
      picture: null,
      refreshToken: t.refresh_token ?? null,
      scopes,
      hasCalendarScopes: hasMicrosoftCalendarScopes(scopes),
      onlineMeetings: tid !== CONSUMER_TENANT, // Teams links need a work or school account
    };
  },
};

// Access tokens live about an hour; keep them per account while the instance is warm.
const accessTokens = new Map<number, { token: string; expiresAt: number; refreshToken: string }>();

async function accessTokenFor(account: CalendarAccount): Promise<string> {
  if (!account.refreshToken) throw new CalendarNotConnectedError(account);
  const cached = accessTokens.get(account.id);
  if (cached && cached.refreshToken === account.refreshToken && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const t = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: await readableToken(account),
    scope: MICROSOFT_SCOPES.join(" "),
  });
  if (t.error || !t.access_token) {
    if (isDeadGrant(t)) {
      await db.update(calendarAccounts).set({ refreshToken: null }).where(eq(calendarAccounts.id, account.id));
      accessTokens.delete(account.id);
      throw new CalendarNotConnectedError(account);
    }
    throw new Error(`Microsoft token refresh failed: ${t.error ?? "no access_token"}`);
  }
  // Microsoft rotates refresh tokens; keep the newest one so the account doesn't go stale.
  let stored = account.refreshToken;
  if (t.refresh_token) {
    stored = encrypt(t.refresh_token);
    await db.update(calendarAccounts).set({ refreshToken: stored }).where(eq(calendarAccounts.id, account.id));
    account.refreshToken = stored;
  }
  if (accessTokens.size > 500) accessTokens.clear();
  accessTokens.set(account.id, { token: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000, refreshToken: stored });
  return t.access_token;
}

/** Decrypt the stored token. One that can't be read (e.g. AUTH_SECRET changed) is useless: drop it. */
async function readableToken(account: CalendarAccount): Promise<string> {
  try {
    return decrypt(account.refreshToken!);
  } catch {
    await db.update(calendarAccounts).set({ refreshToken: null }).where(eq(calendarAccounts.id, account.id));
    throw new CalendarNotConnectedError(account);
  }
}

class GraphError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function graph<T>(account: CalendarAccount, path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
  const token = await accessTokenFor(account);
  const { prefer, ...rest } = init;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(rest.body ? { "Content-Type": "application/json" } : {}),
    ...(prefer ? { Prefer: prefer } : {}),
  };
  // Absolute URLs come from @odata.nextLink. Only ever send the bearer token to Microsoft Graph itself.
  if (path.startsWith("https://") && !path.startsWith(`${GRAPH}/`)) throw new Error("Refusing to call a non-Graph URL");
  const url = path.startsWith("https://") ? path : `${GRAPH}${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...rest, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let body: T & { error?: { code?: string; message?: string } };
    try {
      body = (text ? JSON.parse(text) : {}) as typeof body;
    } catch {
      body = { error: { code: String(res.status), message: res.statusText || "non-JSON response" } } as typeof body;
    }
    if (res.ok) return body as T;
    const code = (body as { error?: { code?: string } }).error?.code ?? String(res.status);
    const message = (body as { error?: { message?: string } }).error?.message ?? res.statusText;
    // Throttled or briefly unavailable: wait as told, once, for idempotent requests.
    if ((res.status === 429 || res.status === 503) && attempt === 0 && (!rest.method || rest.method === "GET")) {
      const wait = Math.min(Number(res.headers.get("Retry-After") ?? 2), 5) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.status === 401 && code === "InvalidAuthenticationToken" && attempt === 0) {
      accessTokens.delete(account.id);
      headers.Authorization = `Bearer ${await accessTokenFor(account)}`;
      continue;
    }
    throw new GraphError(res.status, code, `Microsoft Graph ${res.status} ${code}: ${message}`);
  }
}

/** Follow @odata.nextLink pages, capped so a runaway calendar can't hang a request. */
async function graphPages<T>(account: CalendarAccount, path: string, prefer: string, maxPages = 10): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined = path;
  for (let i = 0; next && i < maxPages; i++) {
    const page: { value?: T[]; "@odata.nextLink"?: string } = await graph(account, next, { prefer });
    items.push(...(page.value ?? []));
    next = page["@odata.nextLink"];
  }
  return items;
}

const UTC_PREFER = 'outlook.timezone="UTC", outlook.body-content-type="text"';

function viewPath(calendarId: string, timeMin: Date, timeMax: Date, select: string) {
  const q = new URLSearchParams({
    startDateTime: timeMin.toISOString(),
    endDateTime: timeMax.toISOString(),
    $select: select,
    $top: "500",
  });
  return `${calendarPath(calendarId)}/calendarView?${q}`;
}

type GraphCalendar = { id: string; name?: string; isDefaultCalendar?: boolean; canEdit?: boolean; hexColor?: string | null; color?: string | null };
type GraphEvent = GraphEventLite & {
  id: string;
  subject?: string;
  location?: { displayName?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
  webLink?: string;
  body?: { content?: string };
  attendees?: GraphAttendee[];
  seriesMasterId?: string | null;
  isOrganizer?: boolean;
  organizer?: { emailAddress?: { name?: string; address?: string } };
  responseStatus?: { response?: string };
};

/** The user's own answer to an invitation; Graph says "none" when they haven't answered. */
function graphResponse(e: GraphEvent): string | undefined {
  if (!e.attendees?.length) return undefined;
  if (e.isOrganizer) return "organizer";
  const r = e.responseStatus?.response;
  return r === "accepted" || r === "declined" ? r : r === "tentativelyAccepted" ? "tentative" : "needsAction";
}

export const microsoftCalendar: CalendarProvider = {
  provider: "microsoft",

  async getBusy(account, calendarIds, timeMin, timeMax, tz) {
    const perCalendar = await Promise.all(
      calendarIds.map((id) =>
        graphPages<GraphEventLite>(account, viewPath(id, timeMin, timeMax, "start,end,showAs,isAllDay,isCancelled"), UTC_PREFER),
      ),
    );
    return busyFromEvents(perCalendar.flat(), tz);
  },

  async listCalendars(account): Promise<CalendarListItem[]> {
    const items = await graphPages<GraphCalendar>(account, "/me/calendars?$select=id,name,isDefaultCalendar,canEdit,hexColor,color&$top=100", "");
    return items
      .map((c) => ({
        id: c.isDefaultCalendar ? "primary" : c.id,
        summary: c.name || "Calendar",
        primary: !!c.isDefaultCalendar,
        color: calendarColor(c),
        canWrite: c.canEdit !== false,
        canReadEvents: true,
      }))
      .sort((a, b) => Number(b.primary) - Number(a.primary) || a.summary.localeCompare(b.summary));
  },

  async listEvents(account, calendars, timeMin, timeMax): Promise<CalendarEvent[]> {
    const select = "id,subject,start,end,isAllDay,isCancelled,location,onlineMeeting,onlineMeetingUrl,webLink,body,attendees,showAs,seriesMasterId,isOrganizer,organizer,responseStatus";
    const results = await Promise.all(
      calendars.map(async (c) => {
        const items = await graphPages<GraphEvent>(account, viewPath(c.id, timeMin, timeMax, select), UTC_PREFER).catch((err) => {
          if (err instanceof CalendarNotConnectedError) throw err;
          logWarn("microsoft", `could not list events for calendar ${c.id} of account ${account.id}: ${(err as Error).message}`);
          return [] as GraphEvent[];
        });
        return items
          .filter((e) => !e.isCancelled)
          .map<CalendarEvent>((e) => ({
            id: e.id,
            seriesId: e.seriesMasterId || undefined,
            accountId: account.id,
            calendarId: c.id,
            calendarName: c.summary,
            title: e.subject || "(No title)",
            start: e.isAllDay ? allDayDate(e.start) : new Date(parseGraphUtc(e.start)).toISOString(),
            end: e.isAllDay ? allDayDate(e.end) : new Date(parseGraphUtc(e.end)).toISOString(),
            allDay: !!e.isAllDay,
            color: c.color,
            location: e.location?.displayName || undefined,
            meetLink: e.onlineMeeting?.joinUrl || e.onlineMeetingUrl || undefined,
            htmlLink: e.webLink || undefined,
            description: e.body?.content?.trim() || undefined,
            attendees: mapAttendees(e.attendees),
            organizer: e.organizer?.emailAddress?.name || e.organizer?.emailAddress?.address || undefined,
            myResponse: graphResponse(e),
            canEdit: c.canWrite,
          }));
      }),
    );
    return results.flat();
  },

  async createEvent(account, calendarId, ev: NewEvent) {
    const body = {
      subject: ev.summary,
      body: { contentType: "text", content: ev.description ?? "" },
      start: toGraphDateTime(ev.start, ev.timeZone),
      end: toGraphDateTime(ev.end, ev.timeZone),
      location: ev.location ? { displayName: ev.location } : undefined,
      attendees: toGraphAttendees(ev.attendees.map((a) => ({ email: a.email, name: a.displayName }))),
      allowNewTimeProposals: false,
      transactionId: ev.requestId, // Graph de-duplicates retries with the same id
      ...(ev.recurrence ? { recurrence: toGraphRecurrence(ev.recurrence, ev.start, ev.timeZone) } : {}),
    };
    const withTeams = ev.onlineMeeting && account.onlineMeetings;
    const path = `${calendarPath(calendarId)}/events`;
    let created: GraphEvent;
    try {
      created = await graph<GraphEvent>(account, path, {
        method: "POST",
        body: JSON.stringify(withTeams ? { ...body, isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : body),
      });
    } catch (err) {
      // Some accounts can't create Teams meetings; fall back to a plain event rather than failing the booking.
      if (!withTeams || !(err instanceof GraphError) || err.status >= 500) throw err;
      logWarn("microsoft", `Teams meeting not available for account ${account.id} (${err.code}); creating without a link`);
      created = await graph<GraphEvent>(account, path, { method: "POST", body: JSON.stringify(body) });
    }
    return {
      id: created.id,
      meetLink: created.onlineMeeting?.joinUrl || created.onlineMeetingUrl || null,
      htmlLink: created.webLink || null,
    };
  },

  async getEvent(account, _calendarId, eventId) {
    try {
      const e = await graph<GraphEvent>(account, `/me/events/${encodeURIComponent(eventId)}?$select=id,isCancelled,attendees`, { prefer: UTC_PREFER });
      return { cancelled: !!e.isCancelled, attendees: mapAttendees(e.attendees) };
    } catch (err) {
      if (err instanceof GraphError && (err.status === 404 || err.status === 410)) return null;
      throw err;
    }
  },

  async setAttendees(account, _calendarId, eventId, attendees) {
    await graph(account, `/me/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      body: JSON.stringify({ attendees: toGraphAttendees(attendees) }),
    });
  },

  async moveEvent(account, _calendarId, eventId, start, end, timeZone) {
    await graph(account, `/me/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      body: JSON.stringify({ start: toGraphDateTime(start, timeZone), end: toGraphDateTime(end, timeZone) }),
    });
  },

  async respond(account, _calendarId, eventId, response, comment) {
    const action = { accepted: "accept", declined: "decline", tentative: "tentativelyAccept" }[response];
    await graph(account, `/me/events/${encodeURIComponent(eventId)}/${action}`, {
      method: "POST",
      body: JSON.stringify({ comment: comment ?? "", sendResponse: true }),
    });
  },

  async deleteEvent(account, _calendarId, eventId) {
    try {
      await graph(account, `/me/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
    } catch (err) {
      if (err instanceof GraphError && (err.status === 404 || err.status === 410)) return;
      throw err;
    }
  },

  async revoke() {
    // Microsoft has no per-app revocation endpoint for refresh tokens (revokeSignInSessions would sign the
    // user out of every app). Deleting our copy of the token is all we can do; users can remove Midore at
    // https://account.microsoft.com/privacy/app-access or myapps.microsoft.com.
  },

  // Graph change notifications on the calendar's events (Calendars.ReadWrite covers them). Event
  // subscriptions last under three days, so the daily job replaces them. Graph calls `address` with a
  // validationToken first, which the webhook echoes back. Graph picks the subscription id; `channelId` is unused.
  async watch(account, calendarId, address, _channelId, token) {
    const resource = calendarId === "primary" ? "/me/events" : `/me/calendars/${encodeURIComponent(calendarId)}/events`;
    const expires = new Date(Date.now() + 2.5 * 86_400_000);
    const sub = await graph<{ id: string; expirationDateTime: string }>(account, "/subscriptions", {
      method: "POST",
      body: JSON.stringify({ changeType: "created,updated,deleted", notificationUrl: address, resource, expirationDateTime: expires.toISOString(), clientState: token }),
    });
    return { channelId: sub.id, resourceId: null, expiresAt: new Date(sub.expirationDateTime) };
  },

  async unwatch(account, channelId) {
    try {
      await graph(account, `/subscriptions/${encodeURIComponent(channelId)}`, { method: "DELETE" });
    } catch {
      // Already expired or removed.
    }
  },
};

export type { GraphDateTime };
