import { getEventType, getUserByUsername } from "@/lib/data";
import { requestBaseUrl } from "@/lib/origin";
import { bookingQrImage } from "./image";

export async function GET(_request: Request, { params }: RouteContext<"/api/booking-qr/[username]/[slug]">) {
  const { username, slug } = await params;
  const user = await getUserByUsername(username);
  const event = user ? await getEventType(user.id, slug) : null;
  if (!user || !event?.active) return new Response("Booking page not found", { status: 404 });

  const url = `${await requestBaseUrl()}/${user.username}/${event.slug}`;
  return bookingQrImage(url, event.title, event.slug);
}
