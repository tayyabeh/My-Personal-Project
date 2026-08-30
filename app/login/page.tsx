export const metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 px-6 dark:bg-neutral-950">
      <form
        action="/api/auth"
        method="post"
        className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
          Personal AI Manager
        </h1>
        <p className="mt-1 text-sm text-neutral-500">Enter your dashboard password.</p>

        <input type="hidden" name="next" value={params.next ?? '/dashboard'} />

        <input
          type="password"
          name="password"
          autoFocus
          required
          autoComplete="current-password"
          className="mt-6 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          placeholder="Password"
        />

        {params.error ? (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">
            That password was not correct.
          </p>
        ) : null}

        <button
          type="submit"
          className="mt-5 w-full rounded-lg bg-neutral-900 px-4 py-2.5 font-medium text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
