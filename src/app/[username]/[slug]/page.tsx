import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { getEventType, getUserByUsername } from "@/lib/data";
import { getBookingByUid } from "@/lib/bookings";
import { PoweredBy } from "@/components/PoweredBy";
import { BookingFlow, type BookingFlowProps } from "./BookingFlow";

export async function generateMetadata(props: PageProps<"/[username]/[slug]">) {
  const { username, slug } = await props.params;
  const user = await getUserByUsername(username);
  const et = user ? await getEventType(user.id, slug) : null;
  return { title: et ? `${et.title} with ${user!.name || user!.username}` : "Not found" };
}

export default async function EventPage(props: PageProps<"/[username]/[slug]">) {
  await connection();
  const { username, slug } = await props.params;
  const { reschedule } = await props.searchParams;
  const user = await getUserByUsername(username);
  const et = user ? await getEventType(user.id, slug) : null;
  if (!user || !et) notFound();

  if (!et.active) {
    return (
      <main className="mx-auto max-w-lg flex-1 px-6 py-28 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">This event is not accepting bookings</h1>
        <p className="mt-3 text-sm text-muted">{user.name || user.username} may have other times available.</p>
        <Link href={`/${user.username}`} className="btn-secondary mt-8">See other events</Link>
      </main>
    );
  }

  let rescheduleInfo: BookingFlowProps["reschedule"];
  if (typeof reschedule === "string") {
    const row = await getBookingByUid(reschedule);
    if (row && row.booking.userId === user.id && row.booking.status === "confirmed") {
      // The link was opened on another of the host's event types: send it to the booking's own type.
      if (row.eventType && row.eventType.id !== et.id)
        redirect(`/${user.username}/${row.eventType.slug}?reschedule=${encodeURIComponent(row.booking.uid)}`);
      rescheduleInfo = {
        uid: row.booking.uid,
        start: row.booking.start.toISOString(),
        duration: Math.round((row.booking.end.getTime() - row.booking.start.getTime()) / 60_000),
        name: row.booking.name,
      };
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-10 sm:px-8 sm:py-14">
      <BookingFlow
        host={{ username: user.username, name: user.name, image: user.image }}
        eventType={{
          slug: et.slug,
          title: et.title,
          description: et.description,
          durations: et.durations,
          locations: et.locations,
          color: et.color,
          questions: et.questions,
          seats: et.seats,
          preferences: et.preferences,
        }}
        reschedule={rescheduleInfo}
      />
      <PoweredBy>
        <Link href={`/${user.username}`} className="hover:text-ink">More from {user.name || user.username}</Link>
        <span aria-hidden>·</span>
        {!rescheduleInfo && (
          <>
            <a href={`/api/booking-qr/${user.username}/${et.slug}`} download className="hover:text-ink">Download QR code</a>
            <span aria-hidden>·</span>
          </>
        )}
      </PoweredBy>
    </main>
  );
}
