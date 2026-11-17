import { fail, redirect } from '@sveltejs/kit';
import {
	checkPasswordFree,
	createSession,
	passwordProblem,
	setPassword,
	setSessionCookie,
	signInWithRecoveryCode
} from '#lib/server/auth.ts';
import { normalizeRecoveryCode } from '#lib/server/crypto.ts';
import type { Actions } from './$types';

function tooMany(seconds: number) {
	return fail(429, { message: `Too many attempts. Try again in ${seconds} seconds.` });
}

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const form = await request.formData();
		const code = normalizeRecoveryCode(String(form.get('code') ?? ''));
		if (!code) return fail(400, { message: "That isn't a recovery code. Check it and try again." });

		const password = String(form.get('password') ?? '');
		const problem = passwordProblem(password, String(form.get('confirmation') ?? ''));
		if (problem) return fail(400, { message: problem });

		const found = await signInWithRecoveryCode(code);
		if (!found.ok) {
			return found.retryAfterSeconds
				? tooMany(found.retryAfterSeconds)
				: fail(401, { message: "That recovery code didn't match any account." });
		}

		const free = await checkPasswordFree(password, found.value.id);
		if (!free.ok) {
			return free.retryAfterSeconds
				? tooMany(free.retryAfterSeconds)
				: fail(400, { message: 'Choose a different password.' });
		}

		// Signs the account out everywhere, then signs this browser back in.
		await setPassword(found.value, password);
		setSessionCookie(cookies, await createSession(found.value));
		redirect(303, '/');
	}
};
