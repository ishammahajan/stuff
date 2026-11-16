import { redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { isValidSession, SESSION_COOKIE } from '#lib/server/auth.ts';

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE);
	event.locals.authenticated = token ? await isValidSession(token) : false;

	// Everything except the login page requires a session.
	if (!event.locals.authenticated && event.url.pathname !== '/login') {
		redirect(303, '/login');
	}

	return resolve(event);
};
