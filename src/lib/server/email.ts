// Server-side email helper (PLAN §5.2 "Email delivery", task #24).
//
// One small, swappable seam for outbound email. It sends via the **Mailgun HTTP
// API** and, when Mailgun is not configured, falls back to logging the magic-link
// URL to the console so local dev works with no Mailgun account.
//
// Mailgun contract (PLAN §5.2):
//   POST `${MAILGUN_BASE_URL}/v3/${MAILGUN_DOMAIN}/messages`
//   - HTTP basic auth `api:<MAILGUN_API_KEY>` (Authorization: Basic <base64>).
//   - body `application/x-www-form-urlencoded` (URLSearchParams) with fields
//     `from`, `to`, `subject`, `text`, and optionally `html`.
//   - No SMTP and no SDK: a plain global `fetch` keeps this serverless-friendly
//     with no per-invocation handshake and no new dependency.
//
// Security (PLAN §12): email is sensitive. We NEVER log the API key, and the
// error path surfaces the response body but never the auth header/credential.
// The dev-fallback console line (URL included) is for local dev only.

import { env } from '$env/dynamic/private';

export interface SendEmailInput {
	to: string;
	subject: string;
	text: string;
	html?: string;
}

/**
 * Low-level send. Reads Mailgun config from `$env/dynamic/private` at call time
 * (not at module load) so that absence is tolerated at build/generate time and
 * tests can vary the env per case.
 *
 * - When Mailgun is NOT configured (api key, domain, or from address
 *   missing/empty): logs a `[email] (dev fallback) …` line and resolves. Never
 *   throws in this path, never logs the API key.
 * - When configured: POSTs to the Mailgun messages endpoint with basic auth and
 *   a form body. On a non-2xx response, throws an Error carrying the status and
 *   the (secret-free) response text — never the credential.
 */
export async function sendEmail({ to, subject, text, html }: SendEmailInput): Promise<void> {
	const apiKey = env.MAILGUN_API_KEY;
	const domain = env.MAILGUN_DOMAIN;
	const from = env.EMAIL_FROM;
	const baseUrl = env.MAILGUN_BASE_URL || 'https://api.mailgun.net';

	// Dev fallback: Mailgun not configured → log instead of send (no throw, no key).
	if (!apiKey || !domain || !from) {
		console.log(`[email] (dev fallback) to=${to} subject=${JSON.stringify(subject)}\n${text}`);
		return;
	}

	const body = new URLSearchParams({ from, to, subject, text });
	if (html) body.set('html', html);

	// Basic auth `api:<key>` — base64 of the credential pair. The key never leaves
	// this header; it is not logged anywhere.
	const authorization = `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`;

	const response = await fetch(`${baseUrl}/v3/${domain}/messages`, {
		method: 'POST',
		headers: {
			Authorization: authorization,
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body
	});

	if (!response.ok) {
		// Surface status + response body for diagnosis, but NEVER the API key.
		const detail = await response.text().catch(() => '');
		throw new Error(`Mailgun send failed (${response.status}): ${detail}`);
	}
}

export interface SendMagicLinkEmailInput {
	to: string;
	url: string;
}

/**
 * Compose and send the passwordless sign-in email (PLAN §5.3). The link is
 * single-use and short-lived; we say so in the body. Delegates to `sendEmail`,
 * so the dev fallback and the Mailgun path are shared. This is the function the
 * better-auth `magicLink` plugin's `sendMagicLink` callback invokes.
 */
export async function sendMagicLinkEmail({ to, url }: SendMagicLinkEmailInput): Promise<void> {
	const subject = 'Sign in to Pay with me';
	const text = [
		'Hi,',
		'',
		'Click the link below to sign in to Pay with me:',
		'',
		url,
		'',
		'This link is single-use and expires soon. If you did not request it, you can safely ignore this email.'
	].join('\n');

	await sendEmail({ to, subject, text });
}
