import { redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { getSessionAccount, SESSION_COOKIE } from '#lib/server/auth.ts';

function isPublic(pathname: string): boolean {
	return (
		pathname === '/login' ||
		pathname === '/recover' ||
		pathname.startsWith('/join/') ||
		// Calendar feeds are unlocked by the token in their link.
		pathname.startsWith('/calendar/')
	);
}

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE);
	event.locals.account = token ? await getSessionAccount(token) : null;

	// Everything except signing in, joining, recovery, and calendar feeds requires a session.
	if (!event.locals.account && !isPublic(event.url.pathname)) {
		if (event.url.pathname.startsWith('/api/')) {
			return Response.json({ error: 'Not signed in.' }, { status: 401 });
		}
		redirect(303, '/login');
	}

	return resolve(event);
};
