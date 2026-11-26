// The training summary the trainer model reads before it plans or advises: history,
// strength per exercise, a suggested next target from a fixed progression rule,
// recent work per muscle, goals and their progress, upcoming and missed workouts,
// and the trainer's notes. Also the progress the Gym screen charts, and which goals
// were reached.
// Pure code with no database or SvelteKit imports, so it can be tested on its own.
import {
	addDays,
	anyDone,
	daysBetween,
	formatSet,
	MOVEMENT_PATTERNS,
	measureOf,
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

/** A set's score for a measure: estimated max, reps, or seconds. */
function score(values: SetValues, measure: Measure): number | null {
	if (measure === 'weight_reps') return estimatedMax(values);
	return measure === 'reps' ? values.reps : values.seconds;
}

/** The number that tracks progress for a measure: estimated max, best reps, or best time. */
function bestScore(exercise: Exercise, measure: Measure = exercise.measure): number | null {
	let best: number | null = null;
	for (const { done } of exercise.sets) {
		if (!done) continue;
		const value = score(done, measure);
		if (value !== null && (best === null || value > best)) best = value;
	}
	return best;
}

/** What a measure's scores count, for labels. */
export function scoreUnit(measure: Measure): string {
	return measure === 'weight_reps' ? 'kg est. max' : measure === 'reps' ? 'reps' : 's';
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

const nameKey = (name: string) => name.trim().toLowerCase();

interface Session {
	record: TrainingRecord;
	date: string;
}

/** Workouts that happened up to today, oldest first. */
function sessionsOf(all: TrainingRecord[], today: string): Session[] {
	return all
		.filter((record) => record.type === 'workout' && performed(record))
		.map((record) => ({ record, date: workoutDate(record) }))
		.filter(({ date }) => date <= today)
		.sort((a, b) => a.date.localeCompare(b.date));
}

/** Each exercise's performances, oldest first, by its name in lower case. */
function historiesOf(sessions: Session[]): Map<string, Performance[]> {
	const byName = new Map<string, Performance[]>();
	for (const { record, date } of sessions) {
		for (const exercise of record.fields.exercises) {
			if (!exercise.sets.some((set) => set.done)) continue;
			const key = nameKey(exercise.name);
			byName.set(key, [...(byName.get(key) ?? []), { date, exercise }]);
		}
	}
	return byName;
}

/** Done sets per muscle in the last 7 days, and the day each muscle was last trained. */
function muscleWork(sessions: Session[], today: string) {
	const weekStart = addDays(today, -6);
	const sets = new Map<Muscle, number>();
	const lastTrained = new Map<Muscle, string>();
	for (const { record, date } of sessions) {
		for (const exercise of record.fields.exercises) {
			const count = exercise.sets.filter((set) => set.done).length;
			if (count === 0) continue;
			for (const muscle of exercise.muscles) {
				lastTrained.set(muscle, date);
				if (date >= weekStart) sets.set(muscle, (sets.get(muscle) ?? 0) + count);
			}
		}
	}
	return MUSCLES.map((muscle) => ({
		muscle,
		sets: sets.get(muscle) ?? 0,
		lastTrained: lastTrained.get(muscle) ?? null
	}));
}

/** One exercise's progress for a chart: its best score in each session. */
export interface ExerciseProgress {
	name: string;
	measure: Measure;
	points: { date: string; value: number }[];
}

/** Every exercise's progress, the most recently done first. */
export function exerciseProgress(all: TrainingRecord[], today: string): ExerciseProgress[] {
	const result: ExerciseProgress[] = [];
	for (const history of historiesOf(sessionsOf(all, today)).values()) {
		const last = history[history.length - 1].exercise;
		const points = history.flatMap(({ date, exercise }) => {
			const value = bestScore(exercise, last.measure);
			return value === null ? [] : [{ date, value: round(value) }];
		});
		if (points.length > 0) result.push({ name: last.name, measure: last.measure, points });
	}
	return result.sort((a, b) => b.points[b.points.length - 1].date.localeCompare(a.points[a.points.length - 1].date));
}

/** A goal's numbers: scores before it was set and now, the target's, and the pace. */
export interface GoalProgress {
	measure: Measure;
	start: number | null;
	current: number | null;
	target: number;
	weeksLeft: number | null;
}

/** The target's own score; a weight goal of more than 12 reps still counts by Epley. */
function targetScore(target: SetValues, measure: Measure): number {
	if (measure === 'weight_reps') {
		const { weight, reps } = target;
		return (reps ?? 1) <= 1 ? (weight ?? 0) : (weight ?? 0) * (1 + (reps ?? 0) / 30);
	}
	return (measure === 'reps' ? target.reps : target.seconds) ?? 0;
}

/** How far a goal is, from the history of its exercise. */
export function goalProgress(record: TrainingRecord, all: TrainingRecord[], today: string): GoalProgress | null {
	const goal = record.fields.goal;
	if (!goal) return null;
	const measure = measureOf(goal.target);
	const history = historiesOf(sessionsOf(all, today)).get(nameKey(goal.exercise)) ?? [];
	const set = record.createdAt.toISOString().slice(0, 10);
	const scores = history
		.map(({ date, exercise }) => ({ date, value: bestScore(exercise, measure) }))
		.filter((entry): entry is { date: string; value: number } => entry.value !== null);
	const best = (entries: { value: number }[]) =>
		entries.length ? round(Math.max(...entries.map((entry) => entry.value))) : null;
	const target = round(targetScore(goal.target, measure));
	const current = best(scores);

	// Weeks left at the trend of the last 8 weeks, when it is rising.
	let weeksLeft: number | null = null;
	const since = addDays(today, -TREND_WEEKS * 7);
	const slope = slopePerDay(
		scores.filter((entry) => entry.date >= since).map((entry) => ({ day: daysBetween(since, entry.date), value: entry.value }))
	);
	if (current !== null && current < target && slope !== null && slope > 0) {
		weeksLeft = Math.ceil((target - current) / (slope * 7));
	}
	return { measure, start: best(scores.filter((entry) => entry.date < set)), current, target, weeksLeft };
}

/** The open goals that a logged set has reached, on any workout, even one dated ahead. */
export function reachedGoals(all: TrainingRecord[]): TrainingRecord[] {
	const goals = all.filter((record) => record.type === 'goal' && !record.completedAt && record.fields.goal);
	if (goals.length === 0) return [];
	const histories = historiesOf(sessionsOf(all, '9999-12-31'));
	return goals.filter((record) => {
		const goal = record.fields.goal!;
		return (histories.get(nameKey(goal.exercise)) ?? []).some(({ exercise }) =>
			exercise.sets.some((set) => reached(goal.target, set.done))
		);
	});
}

/** One goal for the model, with its numbers. */
function goalLine(record: TrainingRecord, all: TrainingRecord[], today: string): string {
	const goal = record.fields.goal!;
	const progress = goalProgress(record, all, today)!;
	const unit = scoreUnit(progress.measure);
	return `  ${JSON.stringify({
		id: record.id,
		title: record.fields.title,
		exercise: goal.exercise,
		target: formatSet(goal.target, progress.measure),
		deadline: record.fields.date,
		set: record.createdAt.toISOString().slice(0, 10),
		...(record.completedAt ? { reached: record.completedAt.toISOString().slice(0, 10) } : {}),
		progress: `${progress.start ?? '?'} → ${progress.current ?? '?'} of ${progress.target} ${unit}`,
		...(progress.weeksLeft !== null ? { weeksLeftAtRecentPace: progress.weeksLeft } : {})
	})}`;
}

/**
 * Summarizes the speaker's training as plain text for the model. `today` is their
 * local date.
 */
export function summarizeTraining(all: TrainingRecord[], today: string): string {
	const workouts = all.filter((record) => record.type === 'workout');
	const notes = all.filter((record) => record.type === 'trainer_note');
	const sessions = sessionsOf(all, today);

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

		lines.push('', 'Recent sessions, newest first:');
		for (const { record, date } of sessions.slice(-RECENT_SESSIONS).reverse()) {
			const muscles = new Set(record.fields.exercises.flatMap((exercise) => exercise.muscles));
			lines.push(`  ${date} ${record.fields.title}: ${[...muscles].join(', ') || 'no muscles tagged'}`);
		}

		lines.push('', 'Muscles: sets done in the last 7 days, and when last trained:');
		for (const { muscle, sets, lastTrained } of muscleWork(sessions, today)) {
			const when = lastTrained ? `last trained ${daysBetween(lastTrained, today)} days ago` : 'never trained';
			lines.push(`  ${muscle}: ${sets} sets, ${when}`);
		}

		// Each exercise's performances, grouped by movement pattern.
		const histories = [...historiesOf(sessions).values()]
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

	// Goals: the open ones, and those reached in the last 30 days.
	const goals = all
		.filter((record) => record.type === 'goal' && record.fields.goal)
		.filter((record) => !record.completedAt || record.completedAt.toISOString().slice(0, 10) >= addDays(today, -30));
	lines.push('', 'Goals (progress as best before the goal was set → best now, of the target):');
	if (goals.length === 0) lines.push('  (none)');
	for (const goal of goals) lines.push(goalLine(goal, all, today));

	// Workouts still to do, and recent ones that were missed, with their IDs.
	const open = workouts
		.filter((record) => !performed(record))
		.map((record) => ({ record, date: workoutDate(record) }))
		.filter(({ date }) => date >= addDays(today, -14))
		.sort((a, b) => a.date.localeCompare(b.date));
	const ahead = open.filter(({ date }) => date >= today);
	const missed = open.filter(({ date }) => date < today);
	const describe = ({ record, date }: Session) =>
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
