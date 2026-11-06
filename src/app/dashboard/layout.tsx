import { requireUser } from "@/lib/auth";
import { enabledProviders, isConnected, listAccounts } from "@/lib/calendar";
import { APP_NAME } from "@/lib/config";
import { requestBaseUrl } from "@/lib/origin";
import { ProviderButton } from "@/components/ProviderButton";
import { DoriCharacterProvider } from "@/components/Dori";
import { CalendarView } from "./CalendarView";
import { DoriPanel } from "./DoriPanel";
import { alertsSoon } from "@/lib/tasks";
import { Overlay } from "./Overlay";
import { MeetingRecorder } from "./MeetingRecorder";
import { ReminderAlerts } from "./ReminderAlerts";
import { TopBar } from "./TopBar";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const user = await requireUser();
  const publicUrl = `${await requestBaseUrl()}/${user.username}`;
  const accounts = await listAccounts(user.id);
  const stale = accounts.filter((a) => !isConnected(a));
  const noneConnected = accounts.every((a) => !isConnected(a));
  const alerts = await alertsSoon(user);

  return (
    <DoriCharacterProvider value={user.doriPrefs?.character ?? "puppy"}>
      {/* One screen: the calendar is always here. Other pages open over it in the overlay; Dori docks beside it. */}
      <div className="flex h-dvh flex-col overflow-hidden bg-surface pt-[env(safe-area-inset-top)]">
        <TopBar name={user.name} email={user.email} image={user.image} publicUrl={publicUrl} />
        {stale.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-vermilion/20 bg-vermilion-subtle px-4 py-2.5">
            <div className="max-w-3xl text-sm text-muted">
              <strong className="text-ink">
                {noneConnected ? "Connect your calendar." : `Reconnect ${stale.map((a) => a.email).join(", ")}.`}
              </strong>{" "}
              {noneConnected
                ? `People can't book you until ${APP_NAME} can see when you're busy and add meetings.`
                : stale.length === 1
                  ? "Its access expired or was revoked. Booking pages are paused until it's reconnected or removed."
                  : "Their access expired or was revoked. Booking pages are paused until they're reconnected or removed."}{" "}
              Allow all calendar permissions on the consent screen.
            </div>
            <div className="flex flex-wrap gap-2">
              {stale.map((a) => (
                <ProviderButton key={a.id} provider={a.provider} reconnect={a.id} label={`Reconnect ${a.email}`} compact />
              ))}
              {noneConnected && stale.length === 0 && enabledProviders().map((p) => <ProviderButton key={p} provider={p} connect compact />)}
            </div>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1">
            <h1 className="sr-only">Calendar</h1>
            {noneConnected ? (
              <div className="grid h-full place-items-center p-8 text-center text-faint">Connect a calendar to see your events here.</div>
            ) : (
              <CalendarView />
            )}
          </main>
          <DoriPanel />
        </div>
      </div>
      <Overlay>{children}</Overlay>
      <ReminderAlerts alerts={alerts} />
      <MeetingRecorder />
    </DoriCharacterProvider>
  );
}
