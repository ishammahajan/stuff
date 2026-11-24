import type { NoteView } from '#lib/items.ts';
import { resumePendingCaptures } from '#lib/server/captures.ts';
import { documentCounts } from '#lib/server/knowledge.ts';
import { listNotes } from '#lib/server/records.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const account = locals.account!;
	await resumePendingCaptures(account);
	const [notes, counts] = await Promise.all([listNotes(account), documentCounts(account)]);
	return {
		notes: notes.map(
			(note): NoteView => ({
				id: note.id,
				...note.fields,
				createdAt: note.createdAt.toISOString(),
				passages: counts.get(note.id) ?? 0
			})
		)
	};
};
