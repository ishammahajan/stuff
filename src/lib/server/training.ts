// The training summary the trainer model reads before it plans or advises: history,
// strength per exercise, a suggested next target from a fixed progression rule,
// recent work per muscle, upcoming and missed workouts, and the trainer's notes.
// Pure code with no database or SvelteKit imports, so it can be tested on its own.
import {
	addDays,
	anyDone,
	daysBetween,
	formatSet,
	MOVEMENT_PATTERNS,
	MUSCLES,
	type Exercise,
	type ItemFields,
	type ItemType,
	type Measure,
	type MovementPattern,
	type Muscle,
	type SetValues
} from '../items.ts';

/** The parts of a stored record the summary reads. */
export interface TrainingRecord {
	id: string;
	type: ItemType;
	createdAt: Date;
	completedAt: Date | null;
	fields: ItemFields;
}

/** One time an exercise was done: its date and its sets. */
interface Performance {
	date: string;
	exercise: Exercise;
}

const RECENT_SESSIONS = 6;
const MAX_EXERCISES = 40;
const TREND_WEEKS = 8;
// Epley's estimate is unreliable for long sets.
const MAX_REPS_FOR_ESTIMATE = 12;

/** A workout's day: its date, or the day it was made. */
export function workoutDate(record: TrainingRecord): string {
	return record.fields.date ?? record.createdAt.toISOString().slice(0, 10);
}

/** Whether a workout happened: it was finished, or any set was logged. */
export function performed(record: TrainingRecord): boolean {
	return record.completedAt !== null || anyDone(record.fields.exercises);
}

/** The estimated one-rep max of a set, by Epley: weight × (1 + reps / 30). */
export function estimatedMax(values: SetValues): number | null {
	const { weight, reps } = values;
	if (!weight || !reps || reps > MAX_REPS_FOR_ESTIMATE) return null;
	return reps === 1 ? weight : weight * (1 + reps / 30);
}

/** The number that tracks progress for a measure: estimated max, best reps, or best time. */
function bestScore(exercise: Exercise): number | null {
	let best: number | null = null;
	for (const { done } of exercise.sets) {
		if (!done) continue;
		const score =
			exercise.measure === 'weight_reps'
				? estimatedMax(done)
				: exercise.measure === 'reps'
					? done.reps
					: done.seconds;
		if (score !== null && (best === null || score > best)) best = score;
	}
	return best;
}

/** The slope of a least-squares line through the points, per day, or null with too few. */
function slopePerDay(points: { day: number; value: number }[]): number | null {
	if (points.length < 2) return null;
	const span = points[points.length - 1].day - points[0].day;
	if (span < 7) return null;
	const meanX = points.reduce((sum, p) => sum + p.day, 0) / points.length;
	const meanY = points.reduce((sum, p) => sum + p.value, 0) / points.length;
	let numerator = 0;
	let denominator = 0;
	for (const p of points) {
		numerator += (p.day - meanX) * (p.value - meanY);
		denominator += (p.day - meanX) ** 2;
	}
	return denominator === 0 ? null : numerator / denominator;
}

/** Whether a done set reached its target in every value the target sets. */
function reached(target: SetValues, done: SetValues | null): boolean {
	if (!done) return false;
	return (
		(target.weight === null || (done.weight ?? 0) >= target.weight) &&
		(target.reps === null || (done.reps ?? 0) >= target.reps) &&
		(target.seconds === null || (done.seconds ?? 0) >= target.seconds)
	);
}

/** Whether every planned set of an exercise was reached, or null when nothing was planned. */
function hitTargets(exercise: Exercise): boolean | null {
	const planned = exercise.sets.filter((set) => set.target);
	if (planned.length === 0) return null;
	return planned.every((set) => reached(set.target!, set.done));
}

/**
 * A reached target, raised to what was done. Weight sets keep the target's reps,
 * since extra reps at a weight already earn the next weight.
 */
function beyond(target: SetValues, done: SetValues): SetValues {
	const higher = (a: number | null, b: number | null) => (a === null ? null : Math.max(a, b ?? 0));
	const weight = higher(target.weight, done.weight);
	return {
		weight,
		reps: weight !== null ? target.reps : higher(target.reps, done.reps),
		seconds: higher(target.seconds, done.seconds)
	};
}

/** How much weight goes on after a success: small for isolation, more for legs. */
function increment(pattern: MovementPattern): number {
	if (pattern === 'isolation') return 1;
	if (pattern === 'squat' || pattern === 'hinge') return 5;
	return 2.5;
}

const roundTo = (value: number, step: number) => Math.round(value / step) * step;

/**
 * The suggested next sets for an exercise, from its latest performances:
 * - every target reached: weight goes up (or one more rep, or 5 more seconds), from
 *   what was done where it beat the target;
 * - a target missed once: the same targets again;
 * - missed twice in a row: back off, to 90% of the weight or to what was done;
 * - nothing was planned: what was done, as the new baseline.
 */
export function nextTarget(history: Performance[]): { sets: SetValues[]; reason: string } | null {
	const last = history[history.length - 1];
	if (!last) return null;
	const { exercise } = last;
	const doneSets = exercise.sets.flatMap((set) => (set.done ? [set.done] : []));
	if (doneSets.length === 0) return null;
	const hit = hitTargets(exercise);
	if (hit === null) return { sets: doneSets, reason: 'repeat what was done, as a baseline' };

	const targets = exercise.sets.flatMap((set) => (set.target ? [set.target] : []));
	if (hit) {
		const step = increment(exercise.pattern);
		const sets = exercise.sets.flatMap(({ target, done }): SetValues[] => {
			if (!target) return [];
			// A set that went past its target shows the real level, for example 22
			// push-ups against a target of 12, so progress from there.
			const base = done ? beyond(target, done) : target;
			if (exercise.measure === 'weight_reps' && base.weight !== null) {
				return [{ ...base, weight: base.weight + step }];
			}
			if (exercise.measure === 'time' && base.seconds !== null) {
				return [{ ...base, seconds: base.seconds + 5 }];
			}
			return [{ ...base, reps: (base.reps ?? 0) + 1 }];
		});
		return { sets, reason: 'every target reached last time' };
	}

	const previous = history[history.length - 2];
	if (previous && hitTargets(previous.exercise) === false) {
		if (exercise.measure === 'weight_reps') {
			const step = exercise.pattern === 'isolation' ? 1 : 2.5;
			const sets = targets.map((target) => ({
				...target,
				weight: target.weight === null ? null : roundTo(target.weight * 0.9, step)
			}));
			return { sets, reason: 'missed targets twice in a row, so back off 10%' };
		}
		return { sets: doneSets, reason: 'missed targets twice in a row, so restart from what was done' };
	}
	return { sets: targets, reason: 'a target was missed last time, so repeat it' };
}

/** "3 × 60 kg × 8" for equal sets, otherwise each set in turn. */
function describeSets(sets: SetValues[], measure: Measure): string {
	const formatted = sets.map((set) => formatSet(set, measure));
	if (formatted.every((text) => text === formatted[0])) {
		return sets.length === 1 ? formatted[0] : `${sets.length} sets of ${formatted[0]}`;
	}
	return formatted.join(', ');
}

function round(value: number, places = 1): number {
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
}

/** One line on an exercise: last time, progress, and the suggested next sets. */
function exerciseLine(history: Performance[], today: string): string {
	const last = history[history.length - 1];
	const { name, measure } = last.exercise;
	const doneSets = last.exercise.sets.flatMap((set) => (set.done ? [set.done] : []));
	const parts = [`${name} (${measure})`, `last ${last.date}: ${describeSets(doneSets, measure)}`];

	const scores = history
		.map((performance) => ({ date: performance.date, score: bestScore(performance.exercise) }))
		.filter((entry): entry is { date: string; score: number } => entry.score !== null);
	const unit = measure === 'weight_reps' ? 'kg' : measure === 'reps' ? 'reps' : 's';
	const label = measure === 'weight_reps' ? 'est. max' : 'best';
	if (scores.length > 0) {
		parts.push(`${label} last time ${round(scores[scores.length - 1].score)} ${unit}`);
		const best = Math.max(...scores.map((entry) => entry.score));
		parts.push(`all-time ${label} ${round(best)} ${unit}`);
		const since = addDays(today, -TREND_WEEKS * 7);
		const recent = scores
			.filter((entry) => entry.date >= since)
			.map((entry) => ({ day: daysBetween(since, entry.date), value: entry.score }));
		const slope = slopePerDay(recent);
		if (slope !== null) {
			const perWeek = round(slope * 7);
			parts.push(`trend ${perWeek >= 0 ? '+' : ''}${perWeek} ${unit}/week over ${recent.length} sessions`);
		}
	}
	const next = nextTarget(history);
	if (next) parts.push(`suggested next: ${describeSets(next.sets, measure)} (${next.reason})`);
	return `  ${parts.join('; ')}`;
}

const label = (value: string) => value.replace(/_/g, ' ');

/**
 * Summarizes the speaker's training as plain text for the model. `today` is their
 * local date.
 */
export function summarizeTraining(all: TrainingRecord[], today: string): string {
	const workouts = all.filter((record) => record.type === 'workout');
	const notes = all.filter((record) => record.type === 'trainer_note');
	const sessions = workouts
		.filter(performed)
		.map((record) => ({ record, date: workoutDate(record) }))
		.filter(({ date }) => date <= today)
		.sort((a, b) => a.date.localeCompare(b.date));

	const lines: string[] = [`Training summary. Today is ${today}. Weights are in kg.`];

	// History and adherence.
	if (sessions.length === 0) {
		lines.push('No workouts logged yet.');
	} else {
		const first = sessions[0].date;
		const last = sessions[sessions.length - 1].date;
		const days = daysBetween(first, today);
		const span = days < 14 ? `${days} ${days === 1 ? 'day' : 'days'}` : `about ${Math.round(days / 7)} weeks`;
		lines.push(
			`Training since ${first} (${span}), ${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'} logged. Last session ${last}, ${daysBetween(last, today)} days ago.`
		);
		// A workout planned for today isn't missed yet, but one done today counts.
		const from = addDays(today, -27);
		const recentWorkouts = workouts.filter((record) => {
			const date = workoutDate(record);
			return date >= from && date <= today;
		});
		const done = recentWorkouts.filter(performed).length;
		const missed = recentWorkouts.filter((record) => !performed(record) && workoutDate(record) < today).length;
		lines.push(
			`Last 4 weeks: ${done} sessions done (${round(done / 4)} a week); planned but missed: ${missed}.`
		);
	}

	if (sessions.length > 0) {
		lines.push('', 'Recent sessions, newest first:');
		for (const { record, date } of sessions.slice(-RECENT_SESSIONS).reverse()) {
			const muscles = new Set(record.fields.exercises.flatMap((exercise) => exercise.muscles));
			lines.push(`  ${date} ${record.fields.title}: ${[...muscles].join(', ') || 'no muscles tagged'}`);
		}

		// Hard sets in the last 7 days, and when each muscle was last trained.
		const weekStart = addDays(today, -6);
		const setsThisWeek = new Map<Muscle, number>();
		const lastTrained = new Map<Muscle, string>();
		for (const { record, date } of sessions) {
			for (const exercise of record.fields.exercises) {
				const count = exercise.sets.filter((set) => set.done).length;
				if (count === 0) continue;
				for (const muscle of exercise.muscles) {
					lastTrained.set(muscle, date);
					if (date >= weekStart) setsThisWeek.set(muscle, (setsThisWeek.get(muscle) ?? 0) + count);
				}
			}
		}
		lines.push('', 'Muscles: sets done in the last 7 days, and when last trained:');
		for (const muscle of MUSCLES) {
			const last = lastTrained.get(muscle);
			const when = last ? `last trained ${daysBetween(last, today)} days ago` : 'never trained';
			lines.push(`  ${muscle}: ${setsThisWeek.get(muscle) ?? 0} sets, ${when}`);
		}

		// Each exercise's performances, oldest first, grouped by movement pattern.
		const byName = new Map<string, Performance[]>();
		for (const { record, date } of sessions) {
			for (const exercise of record.fields.exercises) {
				if (!exercise.sets.some((set) => set.done)) continue;
				const key = exercise.name.trim().toLowerCase();
				byName.set(key, [...(byName.get(key) ?? []), { date, exercise }]);
			}
		}
		const histories = [...byName.values()]
			.sort((a, b) => b[b.length - 1].date.localeCompare(a[a.length - 1].date))
			.slice(0, MAX_EXERCISES);
		lines.push('', 'Exercises by movement pattern, most recent first:');
		for (const pattern of MOVEMENT_PATTERNS) {
			const group = histories.filter((h) => h[h.length - 1].exercise.pattern === pattern);
			if (group.length === 0) continue;
			lines.push(label(pattern));
			for (const history of group) lines.push(exerciseLine(history, today));
		}
	}

	// Workouts still to do, and recent ones that were missed, with their IDs.
	const open = workouts
		.filter((record) => !performed(record))
		.map((record) => ({ record, date: workoutDate(record) }))
		.filter(({ date }) => date >= addDays(today, -14))
		.sort((a, b) => a.date.localeCompare(b.date));
	const ahead = open.filter(({ date }) => date >= today);
	const missed = open.filter(({ date }) => date < today);
	const describe = ({ record, date }: { record: TrainingRecord; date: string }) =>
		`  ${JSON.stringify({ id: record.id, date, title: record.fields.title, exercises: record.fields.exercises.map((e) => e.name) })}`;
	lines.push('', 'Planned workouts ahead:', ...(ahead.length ? ahead.map(describe) : ['  (none)']));
	if (missed.length) lines.push('', 'Missed in the last 2 weeks (not done):', ...missed.map(describe));

	lines.push('', 'Trainer notes, oldest first:');
	if (notes.length === 0) lines.push('  (none yet)');
	for (const note of notes.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
		const { title, details } = note.fields;
		lines.push(`  ${JSON.stringify({ id: note.id, note: title, ...(details ? { details } : {}) })}`);
	}
	return lines.join('\n');
}
