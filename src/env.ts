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
	OPENROUTER_API_KEY: {
		schema: (value) => value || undefined,
		description: 'OpenRouter API key for voice captures; optional so the app starts without it'
	}
});
