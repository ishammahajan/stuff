import { defineEnvVars } from '@sveltejs/kit/env';

function required(name: string) {
	return (value: string | undefined) => {
		if (!value) throw new Error(`${name} must be set`);
		return value;
	};
}

export const variables = defineEnvVars({
	DATABASE_URL: {
		schema: required('DATABASE_URL'),
		description: 'Postgres connection string'
	},
	APP_PASSWORD_HASH: {
		schema: required('APP_PASSWORD_HASH'),
		description: 'Login password hash, produced by `pnpm hash-password`'
	}
});
