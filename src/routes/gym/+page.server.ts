import type { TrainerNoteView, WorkoutView } from '#lib/items.ts';
import { resumePendingCaptures } from '#lib/server/captures.ts';
import { listOfTypes } from '#lib/server/records.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const account = locals.account!;
	await resumePendingCaptures(account);
	const all = await listOfTypes(account, ['workout', 'trainer_note']);
	const workouts: WorkoutView[] = [];
	const notes: TrainerNoteView[] = [];
	for (const record of all) {
		const createdAt = record.createdAt.toISOString();
		if (record.type === 'workout') {
			workouts.push({
				id: record.id,
				...record.fields,
				createdAt,
				completedAt: record.completedAt?.toISOString() ?? null
			});
		} else {
			const { title, details } = record.fields;
			notes.push({ id: record.id, title, details, createdAt });
		}
	}
	notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return { workouts, notes };
};
