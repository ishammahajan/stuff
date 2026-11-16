import { redirect } from '@sveltejs/kit';
import { logout, SESSION_COOKIE } from '#lib/server/auth.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE);
	if (token) await logout(token);
	cookies.delete(SESSION_COOKIE, { path: '/' });
	redirect(303, '/login');
};
