import { OPENROUTER_API_KEY } from '$app/env/private';
import { ITEM_TYPES, type Item, type ItemType } from '../items.ts';

const MODEL = 'google/gemini-3.8-flash';
const TIMEOUT_MS = 60_000;

const RESPONSE_SCHEMA = {
	type: 'object',
	properties: {
		transcript: { type: 'string' },
		items: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					type: { type: 'string', enum: ITEM_TYPES },
					title: { type: 'string' },
					details: { type: ['string', 'null'] },
					amount: { type: ['number', 'null'] },
					currency: { type: ['string', 'null'] },
					date: { type: ['string', 'null'] },
					tags: { type: 'array', items: { type: 'string' } }
				},
				required: ['type', 'title', 'details', 'amount', 'currency', 'date', 'tags'],
				additionalProperties: false
			}
		}
	},
	required: ['transcript', 'items'],
	additionalProperties: false
};

function instructions(localDate: string, timeZone: string): string {
	return `You turn a personal voice memo into structured items for the speaker's own app.

The speaker's local date is ${localDate} and their time zone is ${timeZone}.

First transcribe the audio faithfully, in the language spoken. Then list every distinct item the speaker mentions. One memo can hold several items of different types.

Item types:
- task: something the speaker needs to do.
- expense: money the speaker spent or owes.
- income: money the speaker received.
- note: anything else worth keeping, such as an idea, a fact learned, or a recommendation.

Fields:
- title: a short summary in the speaker's words.
- details: any further information that was said, or null.
- amount: the money amount as a number for expense and income, otherwise null.
- currency: the ISO 4217 code only if the speaker names a currency, otherwise null.
- date: YYYY-MM-DD for a task's due date or the day a transaction happened, resolved against the local date. Use null if no date is said or implied.
- tags: one to three lowercase topic words, for example "movie" or "startup-idea".

If the audio has no speech, return an empty transcript and no items. Do not invent items.`;
}

export interface Interpretation {
	transcript: string;
	items: Item[];
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

/** Keeps only well-formed items, so a malformed model reply can't reach the database. */
function parseItems(value: unknown): Item[] {
	if (!Array.isArray(value)) return [];
	const items: Item[] = [];
	for (const raw of value) {
		if (typeof raw !== 'object' || raw === null) continue;
		const { type, title, details, amount, currency, date, tags } = raw as Record<string, unknown>;
		if (!ITEM_TYPES.includes(type as ItemType)) continue;
		if (typeof title !== 'string' || title.trim() === '') continue;
		items.push({
			type: type as ItemType,
			title: title.trim(),
			details: isNullableString(details) ? details : null,
			amount: typeof amount === 'number' && Number.isFinite(amount) ? amount : null,
			currency: isNullableString(currency) ? currency : null,
			date: typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
			tags: Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string') : []
		});
	}
	return items;
}

/** Sends a WAV recording to the model and returns its transcript and items. */
export async function interpretAudio(
	wav: Buffer,
	localDate: string,
	timeZone: string
): Promise<Interpretation> {
	if (!OPENROUTER_API_KEY) {
		throw new Error('OPENROUTER_API_KEY is not set on the server.');
	}

	const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		signal: AbortSignal.timeout(TIMEOUT_MS),
		headers: {
			Authorization: `Bearer ${OPENROUTER_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: MODEL,
			messages: [
				{ role: 'system', content: instructions(localDate, timeZone) },
				{
					role: 'user',
					content: [
						{ type: 'text', text: 'Here is the voice memo.' },
						{
							type: 'input_audio',
							input_audio: { data: wav.toString('base64'), format: 'wav' }
						}
					]
				}
			],
			response_format: {
				type: 'json_schema',
				json_schema: { name: 'capture', strict: true, schema: RESPONSE_SCHEMA }
			}
		})
	});

	const body = await response.text();
	if (!response.ok) {
		throw new Error(`OpenRouter returned ${response.status}: ${body.slice(0, 300)}`);
	}

	let content: unknown;
	try {
		content = JSON.parse(body).choices?.[0]?.message?.content;
	} catch {
		content = undefined;
	}
	if (typeof content !== 'string') {
		throw new Error(`OpenRouter reply had no message content: ${body.slice(0, 300)}`);
	}

	let parsed: { transcript?: unknown; items?: unknown };
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error(`The model reply was not valid JSON: ${content.slice(0, 300)}`);
	}

	return {
		transcript: typeof parsed.transcript === 'string' ? parsed.transcript : '',
		items: parseItems(parsed.items)
	};
}
