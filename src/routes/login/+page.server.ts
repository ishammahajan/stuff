import { fail, redirect } from '@sveltejs/kit';
import { createSession, setSessionCookie, signIn } from '#lib/server/auth.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.account) redirect(303, '/');
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const password = (await request.formData()).get('password');
		if (typeof password !== 'string' || password.length === 0) {
			return fail(400, { message: 'Enter your password.' });
		}

		const result = await signIn(password);
		if (!result.ok) {
			return result.retryAfterSeconds
				? fail(429, {
						message: `Too many attempts. Try again in ${result.retryAfterSeconds} seconds.`
					})
				: fail(401, { message: 'Wrong password.' });
		}

		setSessionCookie(cookies, await createSession(result.value));
		redirect(303, '/');
	}
};
