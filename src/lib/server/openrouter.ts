import { OPENROUTER_API_KEY } from '$app/env/private';
import { ITEM_TYPES, OPERATION_KINDS, type ItemFields, type ItemType } from '../items.ts';
import type { ProposedOperation } from './records.ts';

const MODEL = 'google/gemini-3.8-flash';
const TIMEOUT_MS = 60_000;
// Model calls per memo: searches, then the final filing call.
const MAX_ROUNDS = 4;

const SEARCH_TOOL = 'search_records';
const FILE_TOOL = 'file_memo';

const nullableType = { type: ['string', 'null'], enum: [...ITEM_TYPES, null] };

const TOOLS = [
	{
		type: 'function',
		function: {
			name: SEARCH_TOOL,
			description:
				"Finds the speaker's records whose title, details, or tags contain the query's words. Returns up to 20 matches, best first, including completed tasks.",
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Keywords, for example "dentist" or "rent".' },
					type: { ...nullableType, description: 'Only records of this type, or null for all.' }
				},
				required: ['query', 'type'],
				additionalProperties: false
			}
		}
	},
	{
		type: 'function',
		function: {
			name: FILE_TOOL,
			description: 'Submits the transcript and the operations. Call this once, last.',
			parameters: {
				type: 'object',
				properties: {
					transcript: { type: 'string' },
					operations: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								action: { type: 'string', enum: OPERATION_KINDS },
								id: { type: ['string', 'null'] },
								type: nullableType,
								title: { type: ['string', 'null'] },
								details: { type: ['string', 'null'] },
								amount: { type: ['number', 'null'] },
								currency: { type: ['string', 'null'] },
								date: { type: ['string', 'null'] },
								tags: { type: ['array', 'null'], items: { type: 'string' } }
							},
							required: [
								'action',
								'id',
								'type',
								'title',
								'details',
								'amount',
								'currency',
								'date',
								'tags'
							],
							additionalProperties: false
						}
					}
				},
				required: ['transcript', 'operations'],
				additionalProperties: false
			}
		}
	}
];

function instructions(context: FilingContext): string {
	return `You file a personal voice memo into the speaker's own app, which keeps their tasks, notes, expenses, and income as records.

The speaker's local date is ${context.localDate} and their time zone is ${context.timeZone}.

First transcribe the audio faithfully, in the language spoken. Then work out what the speaker wants the app to do, and express it as operations:
- create: a new record. Set type and title, and any other field that was said.
- update: change an existing record. Set id, and only the fields that change. Leave the others null.
- complete: mark an existing task as done. Set id only.
- delete: remove an existing record. Set id only. Use it only when the speaker clearly asks to remove something.

File only speech meant for the app, such as "remind me to call the bank", "I spent 20 on lunch", or "note that Sam recommended Dune". Ignore background speech, such as a TV, a phone call, or other people talking, and anything the speaker says to someone else. If nothing is meant for the app, return no operations. Never invent records.

Record types:
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

Existing records:
Below are some of the speaker's records, one JSON object per line: open tasks and the latest notes, expenses, and income. This list is partial. When the speaker refers to a record that is not listed, call ${SEARCH_TOOL} to find it. Use only IDs from this list or from search results. When the speaker talks about a record that already exists, update or complete it instead of creating a duplicate.

${context.snapshot || '(no records yet)'}

When you are done, call ${FILE_TOOL} with the transcript and the operations.`;
}

export interface FilingContext {
	localDate: string;
	timeZone: string;
	/** Some of the speaker's records, for the prompt. */
	snapshot: string;
	/** Runs the search tool over all of the speaker's records. */
	search: (query: string, type: ItemType | null) => unknown;
}

export interface Interpretation {
	transcript: string;
	operations: ProposedOperation[];
}

const isItemType = (value: unknown): value is ItemType => ITEM_TYPES.includes(value as ItemType);

/** Keeps the well-formed fields of a model reply, leaving out the null ones. */
function cleanFields(raw: Record<string, unknown>): Partial<ItemFields> {
	const fields: Partial<ItemFields> = {};
	if (typeof raw.title === 'string' && raw.title.trim()) fields.title = raw.title.trim();
	if (typeof raw.details === 'string' && raw.details.trim()) fields.details = raw.details.trim();
	if (typeof raw.amount === 'number' && Number.isFinite(raw.amount)) fields.amount = raw.amount;
	if (typeof raw.currency === 'string' && raw.currency) fields.currency = raw.currency;
	if (typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)) fields.date = raw.date;
	if (Array.isArray(raw.tags)) fields.tags = raw.tags.filter((tag) => typeof tag === 'string');
	return fields;
}

/** Keeps only well-formed operations, so a malformed model reply can't reach the database. */
function parseOperations(value: unknown): ProposedOperation[] {
	if (!Array.isArray(value)) return [];
	const parsed: ProposedOperation[] = [];
	for (const raw of value) {
		if (typeof raw !== 'object' || raw === null) continue;
		const operation = raw as Record<string, unknown>;
		const fields = cleanFields(operation);
		const id = typeof operation.id === 'string' ? operation.id : null;
		switch (operation.action) {
			case 'create':
				if (!isItemType(operation.type) || !fields.title) break;
				parsed.push({
					action: 'create',
					type: operation.type,
					fields: {
						title: fields.title,
						details: fields.details ?? null,
						amount: fields.amount ?? null,
						currency: fields.currency ?? null,
						date: fields.date ?? null,
						tags: fields.tags ?? []
					}
				});
				break;
			case 'update':
				if (id && Object.keys(fields).length > 0) parsed.push({ action: 'update', id, changes: fields });
				break;
			case 'complete':
			case 'delete':
				if (id) parsed.push({ action: operation.action, id });
				break;
		}
	}
	return parsed;
}

interface ToolCall {
	id: string;
	function: { name: string; arguments: string };
}

interface AssistantMessage {
	role: 'assistant';
	content: string | null;
	tool_calls?: ToolCall[];
}

async function complete(messages: unknown[], toolChoice: unknown): Promise<AssistantMessage> {
	const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		signal: AbortSignal.timeout(TIMEOUT_MS),
		headers: {
			Authorization: `Bearer ${OPENROUTER_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: toolChoice })
	});

	const body = await response.text();
	if (!response.ok) {
		throw new Error(`OpenRouter returned ${response.status}: ${body.slice(0, 300)}`);
	}
	let message: AssistantMessage | undefined;
	try {
		message = JSON.parse(body).choices?.[0]?.message;
	} catch {
		message = undefined;
	}
	if (!message) throw new Error(`OpenRouter reply had no message: ${body.slice(0, 300)}`);
	return message;
}

function parseArguments(call: ToolCall): Record<string, unknown> {
	try {
		const value = JSON.parse(call.function.arguments);
		return typeof value === 'object' && value !== null ? value : {};
	} catch {
		throw new Error(`The model sent invalid tool arguments: ${call.function.arguments.slice(0, 300)}`);
	}
}

/**
 * Sends a WAV recording to the model, lets it search the speaker's records, and
 * returns its transcript and operations.
 */
export async function interpretAudio(wav: Buffer, context: FilingContext): Promise<Interpretation> {
	if (!OPENROUTER_API_KEY) {
		throw new Error('OPENROUTER_API_KEY is not set on the server.');
	}

	const messages: unknown[] = [
		{ role: 'system', content: instructions(context) },
		{
			role: 'user',
			content: [
				{ type: 'text', text: 'Here is the voice memo.' },
				{ type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }
			]
		}
	];

	for (let round = 1; round <= MAX_ROUNDS; round++) {
		// The last round must file, so a model that keeps searching still finishes.
		const toolChoice =
			round === MAX_ROUNDS ? { type: 'function', function: { name: FILE_TOOL } } : 'required';
		const message = await complete(messages, toolChoice);
		const calls = message.tool_calls ?? [];
		if (calls.length === 0) {
			throw new Error(`The model replied without calling a tool: ${(message.content ?? '').slice(0, 300)}`);
		}

		const filing = calls.find((call) => call.function.name === FILE_TOOL);
		if (filing) {
			const args = parseArguments(filing);
			return {
				transcript: typeof args.transcript === 'string' ? args.transcript : '',
				operations: parseOperations(args.operations)
			};
		}

		// Send the message back as it came, because it can carry the model's reasoning.
		messages.push(message);
		for (const call of calls) {
			let result: unknown;
			if (call.function.name === SEARCH_TOOL) {
				const args = parseArguments(call);
				const query = typeof args.query === 'string' ? args.query : '';
				result = context.search(query, isItemType(args.type) ? args.type : null);
			} else {
				result = { error: `Unknown tool ${call.function.name}.` };
			}
			messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
		}
	}
	throw new Error('The model did not file the memo.');
}
