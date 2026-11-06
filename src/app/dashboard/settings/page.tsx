import { AI_PROVIDER_NAME, aiConfigured, usageThisMonth } from "@/lib/ai";
import { requireUser } from "@/lib/auth";
import { calendarsForAccounts, enabledProviders, listAccounts, visibleCalendarIds } from "@/lib/calendar";
import { ensureCategories, listRules } from "@/lib/labels";
import { AiSettings } from "./AiSettings";
import { CategoriesSettings } from "./CategoriesSettings";
import { ensureDefaults } from "@/lib/data";
import { ConnectedCalendars, DangerZone, ProfileForm } from "./SettingsForms";
import { DoriSettings } from "./DoriSettings";
import { DevicesSettings } from "./DevicesSettings";
import { listDevices } from "@/lib/native";
import { appleEnabled } from "@/lib/apple";
import { and, eq } from "drizzle-orm";
import { db, loginIdentities, places } from "@/db";
import { listAutomations } from "@/lib/automations";
import { checkInLabel } from "@/lib/dori/brief";
import { PlacesSettings, RoutinesSettings } from "./RoutinesSettings";
import { SignInSettings } from "./SignInSettings";

export const metadata = { title: "Settings" };
// The "suggest categories" action waits on the AI provider; give it time.
export const maxDuration = 60;

export default async function SettingsPage(props: PageProps<"/dashboard/settings">) {
  const user = await requireUser();
  const sp = await props.searchParams;
  const accounts = await listAccounts(user.id);
  const groups = await calendarsForAccounts(accounts);
  const [cats, rules, usage, defaults, devices, [apple], automationRows, placeRows] = await Promise.all([
    ensureCategories(user.id),
    listRules(user.id),
    aiConfigured() ? usageThisMonth(user.id) : { events: 0, requests: 0 },
    ensureDefaults(user),
    listDevices(user.id),
    db.select().from(loginIdentities).where(and(eq(loginIdentities.userId, user.id), eq(loginIdentities.provider, "apple"))).limit(1),
    listAutomations(user.id),
    db.select({ id: places.id, name: places.name, radiusM: places.radiusM }).from(places).where(eq(places.userId, user.id)),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
      <ProfileForm
        initial={{ name: user.name, username: user.username, headline: user.headline, welcome: user.welcome, timezone: user.timezone }}
      />
      <ConnectedCalendars
        providers={enabledProviders()}
        accounts={groups.map(({ account, calendars, error }) => ({
          id: account.id,
          provider: account.provider,
          email: account.email,
          connected: !!account.refreshToken,
          onlineMeetings: account.onlineMeetings,
          conflictCalendarIds: account.conflictCalendarIds,
          visibleCalendarIds: [...visibleCalendarIds(user, account)],
          calendars,
          error,
        }))}
        initialWrite={{ accountId: user.writeAccountId, calendarId: user.writeCalendarId }}
        flash={typeof sp.error === "string" ? { kind: "error", text: sp.error } : sp.connected === "1" ? { kind: "ok", text: "Calendar connected." } : null}
      />
      <SignInSettings apple={appleEnabled()} linkedEmail={apple ? apple.email : null} privateEmail={!!apple?.privateEmail} flash={sp.linked === "apple" ? "Apple linked. You can now sign in with Apple." : null} />
      <DoriSettings available={aiConfigured()} enabled={!!user.doriConsentAt} nickname={user.doriPrefs?.nickname ?? ""} character={user.doriPrefs?.character ?? "puppy"} briefAt={user.doriPrefs?.briefAt ?? null} workHours={user.workHours} availabilityHours={defaults.schedule.weekly} />
      {aiConfigured() && user.doriConsentAt && (
        <RoutinesSettings
          rules={automationRows.map((r) => ({ id: r.id, label: r.label, enabled: r.enabled, runs: r.runs, lastRunAt: r.lastRunAt?.toISOString() ?? null, oneOff: r.trigger.on === "not_done_by" }))}
          checkIns={(user.doriPrefs?.checkIns ?? []).map((c) => ({ id: c.id, label: checkInLabel(c) }))}
        />
      )}
      <PlacesSettings initial={placeRows} />
      <CategoriesSettings categories={cats} rules={rules} />
      <AiSettings configured={aiConfigured()} providerName={AI_PROVIDER_NAME} enabled={!!user.aiConsentAt} usage={usage} hasCategories={cats.length > 0} />
      <DevicesSettings devices={devices.map((d) => ({ ...d, createdAt: d.createdAt.toISOString(), lastUsedAt: d.lastUsedAt?.toISOString() ?? null }))} />
      <DangerZone />
    </div>
  );
}
