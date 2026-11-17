import { redirect } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { isValidSession, SESSION_COOKIE } from '#lib/server/auth.ts';
import { resumePendingCaptures } from '#lib/server/captures.ts';

export const init: ServerInit = () => {
	// Not awaited, so the first request is not held up by model calls.
	resumePendingCaptures().catch((error) =>
		console.error('Could not resume pending captures:', error)
	);
};

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE);
	event.locals.authenticated = token ? await isValidSession(token) : false;

	// Everything except the login page requires a session.
	if (!event.locals.authenticated && event.url.pathname !== '/login') {
		if (event.url.pathname.startsWith('/api/')) {
			return Response.json({ error: 'Not signed in.' }, { status: 401 });
		}
		redirect(303, '/login');
	}

	return resolve(event);
};
