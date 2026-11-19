import { error } from '@sveltejs/kit';
import { readFeed } from '#lib/server/calendar.ts';
import type { RequestHandler } from './$types';

/**
 * Serves a calendar subscription of task reminders at `/calendar/<token>.ics`. It
 * needs no session: the token in the link is what unlocks the feed.
 */
export const GET: RequestHandler = async ({ params }) => {
	const match = /^([A-Za-z0-9_-]{43})\.ics$/.exec(params.file);
	const ics = match ? await readFeed(match[1]) : null;
	if (!ics) error(404, 'Not found.');
	return new Response(ics, {
		headers: {
			'Content-Type': 'text/calendar; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Robots-Tag': 'noindex'
		}
	});
};
