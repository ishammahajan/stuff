import { addDays, type GoalView, type TrainerNoteView, type WorkoutView } from '#lib/items.ts';
import { resumePendingCaptures } from '#lib/server/captures.ts';
import { listOfTypes } from '#lib/server/records.ts';
import { exerciseProgress, goalProgress, scoreUnit } from '#lib/server/training.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const account = locals.account!;
	await resumePendingCaptures(account);
	const all = await listOfTypes(account, ['workout', 'trainer_note', 'goal']);
	// The server doesn't know the local date. No time zone is more than a day ahead
	// of UTC, so this counts every workout up to the speaker's today.
	const today = addDays(new Date().toISOString().slice(0, 10), 1);
	const workouts: WorkoutView[] = [];
	const notes: TrainerNoteView[] = [];
	const goals: GoalView[] = [];
	for (const record of all) {
		const createdAt = record.createdAt.toISOString();
		const completedAt = record.completedAt?.toISOString() ?? null;
		if (record.type === 'workout') {
			workouts.push({ id: record.id, ...record.fields, createdAt, completedAt });
		} else if (record.type === 'goal') {
			const progress = goalProgress(record, all, today);
			const { title, details, date, goal } = record.fields;
			if (!progress || !goal) continue;
			const { measure, ...numbers } = progress;
			goals.push({ id: record.id, title, details, goal, date, createdAt, completedAt, ...numbers, unit: scoreUnit(measure) });
		} else {
			const { title, details } = record.fields;
			notes.push({ id: record.id, title, details, createdAt });
		}
	}
	notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	goals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return { workouts, notes, goals, progress: exerciseProgress(all, today) };
};
