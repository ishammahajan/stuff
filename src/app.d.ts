// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { Account } from '#lib/server/auth.ts';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/** The signed-in account, with its data key, or null when signed out. */
			account: Account | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
