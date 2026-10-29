import { NextResponse } from "next/server";

/**
 * Proves to Microsoft that this domain belongs to the Entra app (Branding & properties → Publisher domain), so
 * the consent screen shows the domain as the publisher.
 */
export function GET() {
  const applicationId = process.env.MICROSOFT_CLIENT_ID;
  if (!applicationId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ associatedApplications: [{ applicationId }] });
}
