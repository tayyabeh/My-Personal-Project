/**
 * Where Google sends you back after you approve access.
 *
 * This URL must be listed exactly in the OAuth client's "Authorised
 * redirect URIs", or Google refuses with redirect_uri_mismatch.
 */
import { exchangeCode } from '@/lib/google/oauth';
import { makeState } from '../connect/route';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';

function page(title: string, body: string, ok: boolean): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${title}</title>
     <div style="font-family:system-ui,sans-serif;max-width:34rem;margin:16vh auto;padding:0 1.5rem;line-height:1.6">
       <h1 style="font-size:1.5rem;margin:0 0 .5rem">${ok ? '✅' : '⚠️'} ${title}</h1>
       <p style="color:#555">${body}</p>
     </div>`,
    { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const error = params.get('error');
  if (error) {
    return page('Not connected', `Google returned: ${error}. Nothing was saved.`, false);
  }

  // Confirms this callback belongs to a flow we started.
  if (params.get('state') !== makeState()) {
    return page('Not connected', 'That sign-in did not come from this app.', false);
  }

  const code = params.get('code');
  if (!code) return page('Not connected', 'Google did not send an authorisation code.', false);

  try {
    await exchangeCode(code);
    return page(
      'Google connected',
      'Calendar, Gmail and Drive are now linked. You can close this tab and go back to WhatsApp.',
      true,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Google callback failed', { error: message });
    return page('Not connected', message, false);
  }
}
