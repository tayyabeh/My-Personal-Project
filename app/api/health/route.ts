/**
 * Which build is actually live.
 *
 * Vercel sets VERCEL_GIT_COMMIT_SHA at build time, so this reports the
 * exact commit serving traffic. Without it, confirming a deploy landed
 * means guessing from timings, which wasted real time during the build.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return Response.json({
    ok: true,
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? 'local').slice(0, 7),
    deployedAt: process.env.VERCEL_DEPLOYMENT_ID ? undefined : 'local',
    now: new Date().toISOString(),
  });
}
