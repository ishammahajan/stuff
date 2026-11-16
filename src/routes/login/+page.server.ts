import { fail, redirect } from '@sveltejs/kit';
import { login, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from '#lib/server/auth.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.authenticated) redirect(303, '/');
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const password = (await request.formData()).get('password');
		if (typeof password !== 'string' || password.length === 0) {
			return fail(400, { message: 'Enter your password.' });
		}

		const result = await login(password);
		if (!result.ok) {
			return result.retryAfterSeconds
				? fail(429, {
						message: `Too many attempts. Try again in ${result.retryAfterSeconds} seconds.`
					})
				: fail(401, { message: 'Wrong password.' });
		}

		cookies.set(SESSION_COOKIE, result.token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			maxAge: SESSION_MAX_AGE_SECONDS
		});
		redirect(303, '/');
	}
};
