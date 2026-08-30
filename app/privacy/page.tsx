/**
 * Privacy policy.
 *
 * Google requires a reachable privacy policy URL before an OAuth app can
 * be published out of "Testing". This is a truthful description of what
 * the app actually does, which is what the requirement is for.
 */
export const metadata = {
  title: 'Privacy Policy',
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 text-neutral-800 dark:text-neutral-200">
      <h1 className="mb-2 text-3xl font-semibold">Privacy Policy</h1>
      <p className="mb-10 text-sm text-neutral-500">Last updated: 31 August 2026</p>

      <section className="space-y-4 leading-relaxed">
        <p>
          This is a personal assistant application built and operated by a single individual for
          their own private use. It has no other users, and no accounts can be created.
        </p>

        <h2 className="pt-6 text-xl font-semibold">What data is handled</h2>
        <p>
          The application stores messages sent to and from the operator&apos;s own WhatsApp number,
          transcripts of their own voice notes, and the tasks, reminders and notes they create. If
          Google services are connected, it reads the operator&apos;s own Gmail messages, Google
          Calendar events and Google Drive files in order to summarise them back to that same
          person.
        </p>

        <h2 className="pt-6 text-xl font-semibold">How it is stored</h2>
        <p>
          Data is held in a private Supabase database accessible only to the operator. Google access
          tokens are stored solely to keep the connection working and are never shared.
        </p>

        <h2 className="pt-6 text-xl font-semibold">Who it is shared with</h2>
        <p>
          Nobody. Data is never sold, published or shared with third parties. Message text is sent to
          Groq for language processing and transcription so the assistant can respond, and to Meta
          in order to deliver WhatsApp messages. Those providers process it to perform that service.
        </p>

        <h2 className="pt-6 text-xl font-semibold">Deletion</h2>
        <p>
          The operator can delete any or all stored data at any time by removing it from the
          database. Google access can be revoked at any time from the Google Account permissions
          page, which immediately ends this application&apos;s access.
        </p>

        <h2 className="pt-6 text-xl font-semibold">Contact</h2>
        <p>tayyabeh1807@gmail.com</p>
      </section>
    </main>
  );
}
