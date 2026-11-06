import Link from "next/link";
import { AI_PROVIDER_NAME, aiConfigured } from "@/lib/ai";

const AI_MODEL = process.env.AI_MODEL ?? "";
const DORI_MODEL = process.env.DORI_MODEL || AI_MODEL;
// Dori's voice goes through OpenRouter (see src/lib/ai/audio.ts).
const VOICE = (() => {
  try {
    return !!process.env.AI_API_KEY && new URL(process.env.AI_BASE_URL ?? "").hostname === "openrouter.ai";
  } catch {
    return false;
  }
})();
import { APP_NAME, CONTACT_EMAIL, SOURCE_URL, siteHost } from "@/lib/config";
import { ContactLine, LegalPage } from "@/components/LegalPage";

export const metadata = {
  title: "Privacy policy",
  description: `How ${APP_NAME} collects, uses, shares, protects and deletes your data, including Google user data.`,
};

const UPDATED = "November 6, 2026";

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" updated={UPDATED}>
      <p>
        {APP_NAME} is a free, open-source scheduling service. People connect their Google Calendar, publish booking
        links, and others use those links to book meetings with them. Hosts can also keep their tasks in{" "}
        {APP_NAME}, have them planned around their calendar, and, if they choose, talk to Dori, an optional
        assistant. This policy explains what data {APP_NAME}{" "}
        collects, how it is used and shared, how it is protected, and how you can delete it. It applies to the
        service at {siteHost()}{APP_NAME === "Midore" && ", which was called DoorCal until October 2026"}. {APP_NAME} works with Google Calendar and with Microsoft (Outlook, Microsoft 365). Copies of the{" "}
        <a href={SOURCE_URL} target="_blank" rel="noreferrer">open-source code</a> run by other people are separate
        services with their own policies.
      </p>
      <p>
        In this policy, a <strong>host</strong> is someone who signs in with Google and shares booking links, and an{" "}
        <strong>invitee</strong> is someone who books a meeting through a host&apos;s link.
      </p>

      <h2>1. Information we collect</h2>
      <h3>From hosts, through Google or Microsoft sign-in</h3>
      <ul>
        <li>Your name, email address, profile picture (Google only) and the provider&apos;s account ID.</li>
        <li>
          An OAuth refresh token that lets {APP_NAME} reach your calendar while you are not on the site, for example
          when someone books you. It is stored encrypted. You can connect several Google and Microsoft accounts; each
          has its own token.
        </li>
      </ul>
      <h3>From hosts, through Sign in with Apple</h3>
      <ul>
        <li>
          Apple&apos;s account ID for you, your email address (or the private relay address Apple creates if you
          choose to hide your email) and, the first time only, your name. Apple gives {APP_NAME} no access to your
          calendar; you connect a Google or Microsoft calendar separately.
        </li>
        <li>
          A token Apple issues for {APP_NAME}, stored encrypted and used only to revoke {APP_NAME}&apos;s access at Apple
          when you unlink Apple or delete your account.
        </li>
      </ul>
      <h3>From hosts, through Google Calendar</h3>
      <p>{APP_NAME} asks for three Google Calendar permissions and uses each one only as described here:</p>
      <ul>
        <li>
          <strong>See your free/busy information</strong> (<code>calendar.freebusy</code>). When someone opens your
          booking page or books a time, we check which times you are busy across the calendars you chose, so nobody
          can book you when you are not free. We only receive busy time ranges, not event details, and we don&apos;t
          store them.
        </li>
        <li>
          <strong>See the list of your calendars</strong> (<code>calendar.calendarlist.readonly</code>). On the
          Settings page we list your calendars so you can choose which ones count for conflicts and which one new
          bookings go to. We store only the IDs of the calendars you select.
        </li>
        <li>
          <strong>View and edit events on your calendars</strong> (<code>calendar.events</code>). We use this to
          show your events in your {APP_NAME} dashboard, to create the calendar event (with a Google Meet link for
          online meetings) when someone books you or when you create a meeting in {APP_NAME}, to update it when a
          booking is rescheduled, and to delete it or remove an attendee when a booking is cancelled. We store the ID
          and Google Meet link of events {APP_NAME} creates for bookings. We don&apos;t store the contents of your
          other events; they are fetched when you view your dashboard and not kept.
        </li>
      </ul>
      <h3>From hosts, through Microsoft</h3>
      <p>
        For Microsoft accounts we ask for the <code>Calendars.ReadWrite</code> permission (plus basic profile and
        sign-in permissions) and use it in the same three ways: to find your busy times, to list your calendars, and
        to show, create, update and delete events for the meetings booked with you, with a Microsoft Teams link for
        work and school accounts. Outlook sends the invitations.
      </p>
      <h3>Event categories and AI categorisation (optional)</h3>
      <p>
        You can sort your calendar into categories with your own rules. {APP_NAME} then stores a category and
        priority per event together with a scrambled fingerprint of its title, never the title itself.
      </p>
      {aiConfigured() ? (
        <p>
          If you switch on <strong>AI categorisation</strong> in Settings (it is off until you do), {APP_NAME}{" "}
          sends a minimal description of events that no rule covers to {AI_PROVIDER_NAME} so that a model can
          suggest a category: the event title, its length, whether it repeats, how many attendees it has (not who
          they are), whether it has a video link, and the calendar&apos;s name. Descriptions, attendee names and
          addresses, free/busy data and booking details are never sent, and requests are subject to daily limits
          per user and for the whole service.{AI_MODEL ? ` The model currently used is ${AI_MODEL}.` : ""} The provider processes this only to answer the request
          and does not use it to train or improve AI models: under OpenAI&apos;s API terms, data sent to the API is
          not used for training and is retained for at most 30 days for abuse monitoring; OpenRouter is
          instructed, on every request, to route only to OpenAI or to Microsoft&apos;s Azure OpenAI Service (which
          hosts the same models under the same no-training terms) and only to providers that do not store or
          train on data. In our OpenRouter account, zero data retention is enforced for OpenAI models, so requests
          are served only by endpoints that do not store them; routing to providers that may train on data is
          disabled; and prompt logging is switched off. {APP_NAME}{" "}
          itself keeps only the resulting category label. You can switch this off at any time, which also deletes
          the AI-suggested labels.
        </p>
      ) : (
        <p>AI categorisation is not enabled on this instance; no event data is sent to any AI provider.</p>
      )}
      <h3>Tasks and planning</h3>
      <p>
        If you use Tasks, {APP_NAME} stores what you enter: your areas, projects and tasks, with their notes, due
        dates, estimates, priorities, links between tasks, and the names of people you type in. {APP_NAME} then
        plans your open tasks into free time around your calendar. The planning is done by {APP_NAME}&apos;s own
        code, not by an AI model; it uses the busy times from the calendars you chose for conflicts, and stores
        only the resulting planned times and which task each belongs to, not the details of your events.
      </p>
      <p>
        To keep the plan current, {APP_NAME} asks Google and Microsoft to notify it when events change on those
        calendars. A notification says only that something changed, not what; {APP_NAME} then reads your busy
        times again and moves planned work if needed. Planned work stays in {APP_NAME} and is never written to
        your calendar unless you add it yourself.
      </p>
      <h3>Dori, the assistant (optional)</h3>
      {aiConfigured() ? (
        <>
          <p>
            Dori is off until you turn her on. When you message her, {APP_NAME} sends {AI_PROVIDER_NAME} what she
            needs to answer: your message, any photo or PDF you attach to it, the upcoming items of a calendar link you
            give her to read (such as a course calendar), and your recent conversation with her; your areas, projects and tasks
            (titles, notes, dates, estimates, priorities and the names of people you typed); notes she keeps for
            you, such as &ldquo;not in the mood for writing today&rdquo;; the rules and check-ins you set up and the names
            (not the locations) of places you saved; your working hours and planned work; and,
            from your calendars for the coming week (or a range you ask about), each event&apos;s title, start and
            end time, calendar name, number of attendees and your own answer to the invitation; your booking pages (title, lengths, link) and booking
            hours; and, when you ask about bookings, each booking&apos;s page, time and number of guests. When you
            ask about one meeting (&ldquo;who&apos;s in my 3 pm?&rdquo;), she also gets that meeting&apos;s guest
            names (or email addresses when a guest has no name), their answers, its organizer, location and video
            link. Booker names and email addresses, answers to booking questions and event descriptions are
            never sent.{DORI_MODEL ? ` The model currently used is ${DORI_MODEL}.` : ""}{" "}
            The same no-training and zero-data-retention setup described above for AI categorisation applies, and
            requests are subject to daily limits per user and for the whole service.
          </p>
          <p>
            Dori can add, change, complete and remove your tasks, projects and areas, set reminders, and change your
            booking pages and booking hours; every one of these changes can be undone. She never changes your
            calendar or anyone&apos;s booking on her own: she can offer to add an event, to move or delete one of
            your own events that has no other guests, or to cancel a booking, and each happens only when you press
            its button. She can also prepare emails, which
            open in your own mail app with the recipients filled in by {APP_NAME} in your browser; {APP_NAME} never
            sends them. Your conversation with Dori is stored in {APP_NAME} until you clear it or turn Dori off,
            which also deletes the notes she kept. Photos and PDFs you attach are sent with that one message and are not
            stored; only their file names stay in the conversation.
          </p>
          <p>
            {VOICE
              ? `If you talk to Dori with the microphone, your recording is sent through OpenRouter to ElevenLabs to be turned into text; only the text is kept, as your message. If you have Dori read an answer aloud, the text of that answer is sent the same way to be turned into speech. Both requests are restricted to endpoints that keep no data (zero data retention) and do not use it for training, and ${APP_NAME} stores neither recordings nor audio.`
              : "Voice input, where available, uses your browser's own speech recognition, and reading answers aloud uses your browser's built-in voices."}
          </p>
        </>
      ) : (
        <p>Dori is not enabled on this instance; no task or calendar data is sent to any AI provider.</p>
      )}
      <h3>Settings hosts create</h3>
      <p>
        Your username, display name, headline, welcome message, time zone, availability schedules and event types,
        including any questions you ask invitees. Also any rules you set up (&ldquo;every time I finish a chapter,
        add a review&rdquo;) and times you asked Dori to check in with you.
      </p>
      <h3>Places you save</h3>
      <p>
        If you save a place (such as Home or Work) for reminders on arriving or leaving, {APP_NAME} stores its name,
        its coordinates and the distance you chose. The coordinates come from your browser&apos;s location, which it
        asks you to share once when you press &ldquo;Use where I am now&rdquo;, or from coordinates or a map link you
        paste. The Midore phone app hands your saved places to your phone&apos;s own location service (Apple&apos;s or
        Google&apos;s), which tells the app when you arrive or leave so it can show the reminder; this needs your
        phone&apos;s location permission. {APP_NAME} never receives or stores where you are, only the places you saved.
        Dori sees only the names of your places, never where they are. Removing a place deletes it.
      </p>
      <h3>Weather and travel times</h3>
      <p>
        Only when you ask Dori about the weather or how long it takes to get somewhere. For the weather, we send
        the place&apos;s coordinates, rounded to about a kilometre, to Apple (WeatherKit) or, when Apple&apos;s
        service isn&apos;t available, to the Norwegian Meteorological Institute (MET Norway). For a travel time, we
        send Apple Maps the start and end points: a saved place&apos;s coordinates, or an address or
        place name you gave or that is the location of the calendar event you asked about, with the time you want
        to leave or arrive. Nothing that identifies you (your name, email or account) is sent with these requests,
        and {APP_NAME} keeps the forecasts it receives for at most 30 minutes. If you ask about the weather without
        naming a place and have no saved Home, Dori guesses your city: the city your connection comes from (which our
        hosting provider, Vercel, works out from your IP address) if it fits your time zone, or otherwise your time
        zone&apos;s city, and she says it&apos;s a guess. The guess is kept in your settings (the city&apos;s name and
        coordinates rounded to about a kilometre, with your time zone) until your time zone changes. If you tell Dori
        the city you live in, she keeps that instead, the same way.
      </p>
      <h3>From invitees</h3>
      <p>
        When you book a meeting we collect the details you enter: your name, email address, any guest email
        addresses, a phone number if the meeting is a phone call, your answers to the host&apos;s questions, your
        notes, and your time zone. Invitees don&apos;t need an account and we don&apos;t access invitees&apos;
        calendars.
      </p>
      <h3>Technical information</h3>
      <ul>
        <li>
          Cookies: a session cookie that keeps hosts signed in (30 days) and a short-lived cookie used during Google
          sign-in (10 minutes). We don&apos;t use analytics, advertising or tracking cookies.
        </li>
        <li>
          IP addresses, used to limit abuse of booking pages. We store only a one-way hash of your IP address in
          short-lived request counters, never the address itself.
        </li>
        <li>Standard request logs kept by our hosting provider for operating and securing the service.</li>
      </ul>

      <h2>2. How we use information</h2>
      <ul>
        <li>To provide scheduling: show availability, take bookings, and create, update and cancel calendar events.</li>
        <li>To show hosts their calendar, bookings and settings in the dashboard.</li>
        <li>To keep hosts&apos; tasks, plan them around their calendar, and, if they turn it on, let Dori answer and act on their requests.</li>
        <li>To let invitees view, reschedule or cancel their own booking.</li>
        <li>To keep the service secure and working, including preventing spam and abuse.</li>
      </ul>
      <p>We don&apos;t use your data for advertising, we don&apos;t sell it, and we don&apos;t build profiles of you.</p>

      <h2>3. Google user data and Limited Use</h2>
      <p>
        {APP_NAME}&apos;s use and transfer to any other app of information received from Google APIs will adhere to{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>
      <ul>
        <li>We use Google user data only to provide and improve the scheduling features you use.</li>
        <li>We don&apos;t transfer it to others except as needed to provide the service, to comply with law, or as part of a merger or acquisition with notice to you.</li>
        <li>We don&apos;t use it for advertising, including retargeting, personalized or interest-based ads.</li>
        <li>We don&apos;t sell it, and we don&apos;t use it to train or improve generalized AI or machine-learning models.</li>
        <li>
          No person reads your Google data unless you ask us to (for example for support), it is needed for
          security or to investigate abuse, or the law requires it.
        </li>
      </ul>

      <h2>4. How information is shared</h2>
      <ul>
        <li>
          <strong>Between host and invitee.</strong> When an invitee books, the host sees the details the invitee
          entered, and both see the meeting details. These details are written into the host&apos;s Google Calendar
          event, and Google sends the invitation and any updates to the invitee and their guests.
        </li>
        <li>
          <strong>Service providers</strong> that run {APP_NAME} for us and may process data only on our
          instructions: Vercel (hosting) and Neon (database). Data may be processed in the United States and other
          countries where these providers operate.
        </li>
        <li><strong>Google and Microsoft</strong>, to read and update your calendars as described above.</li>
        <li>
          <strong>Apple</strong> (Apple Maps and WeatherKit) and <strong>MET Norway</strong>, only when you ask
          Dori about the weather or travel times, and only the places and times described above.
        </li>
        {aiConfigured() && (
          <li>
            <strong>The AI provider</strong> ({AI_PROVIDER_NAME}), only if you turn on AI categorisation or Dori, and
            only what is described above. It may not use the data to train or improve AI models.
          </li>
        )}
        {VOICE && (
          <li>
            <strong>ElevenLabs</strong>, through OpenRouter, only for Dori&apos;s voice: recordings you make with her
            microphone and answers you ask her to read aloud, on zero-data-retention endpoints.
          </li>
        )}
        <li><strong>When required by law</strong>, or to protect the rights, safety and security of users and the service.</li>
      </ul>
      <p>We don&apos;t sell or rent personal information to anyone.</p>

      <h2>5. How information is protected</h2>
      <ul>
        <li>All traffic to {APP_NAME} is encrypted with HTTPS.</li>
        <li>Refresh tokens are encrypted at rest with AES-256-GCM. Access tokens are kept only in memory, briefly.</li>
        <li>
          A host&apos;s dashboard, calendar and bookings are available only to that host after signing in. A
          host&apos;s public profile and event types are visible to anyone with the link, by design. Invitees can
          reach only their own booking, through its private link.
        </li>
        <li>Our database provider encrypts stored data, and access to production systems is limited to the operator.</li>
      </ul>
      <p>No system is perfectly secure, but we work to protect your data and will notify affected users of a breach as required by law.</p>

      <h2>6. How long we keep data, and how to delete it</h2>
      <ul>
        <li>
          <strong>Hosts:</strong> your data is kept while your account exists. You can delete your account at any
          time in <strong>Settings → Delete account</strong>. This immediately deletes your profile, settings, event
          types, schedules, tasks, plan, conversation with Dori and booking history from our database and revokes
          {" "}{APP_NAME}&apos;s access to your Google accounts. Calendar events already on your calendars stay
          there, under your control.
        </li>
        <li>
          <strong>Removing a connected account</strong> (Settings → Connected calendars → Remove) deletes its stored
          token and, for Google, revokes {APP_NAME}&apos;s access. Microsoft doesn&apos;t let apps revoke their own
          access, so also remove {APP_NAME} at{" "}
          <a href="https://account.microsoft.com/privacy/app-access" target="_blank" rel="noreferrer">account.microsoft.com/privacy/app-access</a>{" "}
          (personal accounts) or <a href="https://myapps.microsoft.com" target="_blank" rel="noreferrer">myapps.microsoft.com</a>{" "}
          (work and school accounts). Google access can also be revoked at{" "}
          <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">myaccount.google.com/permissions</a>.
        </li>
        <li>
          <strong>Invitees:</strong> booking details are kept as part of the host&apos;s booking history until the
          host deletes their account, or until you ask us to delete them.
        </li>
        <li>
          <strong>Tasks and Dori:</strong> tasks and projects are kept until you delete them. Your conversation with
          Dori is kept until you clear it or turn Dori off. The plan is recomputed and overwritten as things change.
        </li>
        <li>Deleted data may remain in our database provider&apos;s backups for a short period (up to about 30 days) before it is overwritten.</li>
      </ul>

      <h2>7. Your choices and rights</h2>
      <p>
        You can see and change your data in the dashboard, and delete it as described above. You can also ask us to
        access, correct, export or delete your personal information, including booking details you entered as an
        invitee, by contacting us. Depending on where you live, you may have further rights under privacy laws such
        as PIPEDA, the GDPR or US state laws, and you may complain to your data protection authority.
      </p>

      <h2>8. Children</h2>
      <p>
        {APP_NAME} is not directed to children under 13 and we don&apos;t knowingly collect their personal
        information. If you believe a child has given us information, contact us and we will delete it.
      </p>

      <h2>9. Changes to this policy</h2>
      <p>
        We will post any changes on this page and update the date above. If a change materially affects how we use
        Google user data or other personal information, we will tell hosts by email before it takes effect.
      </p>

      <h2>10. Contact</h2>
      <ContactLine email={CONTACT_EMAIL} />
      <p>
        See also the <Link href="/terms">terms of service</Link>.
      </p>
    </LegalPage>
  );
}
