import { fail } from '@sveltejs/kit';
import {
	checkPasswordFree,
	createAccount,
	createSession,
	isInviteValid,
	passwordProblem,
	setSessionCookie
} from '#lib/server/auth.ts';
import { adoptUnownedCaptures } from '#lib/server/captures.ts';
import type { Actions, PageServerLoad } from './$types';

const EXPIRED = 'This invite link has expired or was already used.';

export const load: PageServerLoad = async ({ params }) => {
	return { valid: await isInviteValid(params.token) };
};

export const actions: Actions = {
	default: async ({ request, params, cookies }) => {
		const form = await request.formData();
		const password = String(form.get('password') ?? '');
		const problem = passwordProblem(password, String(form.get('confirmation') ?? ''));
		if (problem) return fail(400, { message: problem });

		const free = await checkPasswordFree(password);
		if (!free.ok) {
			return fail(free.retryAfterSeconds ? 429 : 400, {
				message: free.retryAfterSeconds
					? `Too many attempts. Try again in ${free.retryAfterSeconds} seconds.`
					: 'Choose a different password.'
			});
		}

		const created = await createAccount(params.token, password);
		if (!created) return fail(410, { message: EXPIRED });

		if (created.adoptUnowned) await adoptUnownedCaptures(created.account);
		setSessionCookie(cookies, await createSession(created.account));
		return { recoveryCode: created.recoveryCode };
	}
};
