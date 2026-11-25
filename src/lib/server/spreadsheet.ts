// Reads the first worksheet of a spreadsheet into a grid of cell values. It knows
// just enough of two formats for bank statements: Excel 97 `.xls` (BIFF8 inside an
// OLE2 compound file) and `.xlsx` (XML inside a zip). The format comes from the
// file's first bytes, never its name. It has no SvelteKit imports, so scripts can
// use it.
import { inflateRawSync } from 'node:zlib';

/** A cell's value: text, a number, or '' for an empty cell. */
export type Cell = string | number;
export type Grid = Cell[][];

const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// Generous for any statement, small enough that a hostile file can't exhaust memory.
const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 20000;
const MAX_COLUMNS = 256;

export class SpreadsheetError extends Error {}

/** Whether the bytes look like a spreadsheet this module reads. */
export function isSpreadsheet(bytes: Buffer): boolean {
	return bytes.subarray(0, 8).equals(OLE2) || bytes.subarray(0, 4).equals(ZIP);
}

/** The first worksheet of an `.xls` or `.xlsx` file, row by row. */
export function readGrid(bytes: Buffer): Grid {
	if (bytes.subarray(0, 8).equals(OLE2))
		return readBiff(readCompoundStream(bytes, ['Workbook', 'Book']));
	if (bytes.subarray(0, 4).equals(ZIP)) return readXlsx(readZip(bytes));
	throw new SpreadsheetError('This is not an Excel file.');
}

/** Puts a value in the grid, growing it as needed. */
function setCell(grid: Grid, row: number, column: number, value: Cell) {
	if (row >= MAX_ROWS || column >= MAX_COLUMNS)
		throw new SpreadsheetError('The sheet is too large.');
	while (grid.length <= row) grid.push([]);
	const cells = grid[row];
	while (cells.length < column) cells.push('');
	cells[column] = typeof value === 'string' ? value.trim() : value;
}

// ---------------------------------------------------------------- OLE2 compound file

const FREE = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;

/** Returns the named stream of a compound file (the container of `.xls`). */
function readCompoundStream(bytes: Buffer, names: string[]): Buffer {
	if (bytes.length < 512) throw new SpreadsheetError('The file is cut short.');
	const sectorSize = 1 << bytes.readUInt16LE(0x1e);
	const miniSectorSize = 1 << bytes.readUInt16LE(0x20);
	if (sectorSize !== 512 && sectorSize !== 4096) throw new SpreadsheetError('The file is damaged.');
	const fatSectorCount = bytes.readUInt32LE(0x2c);
	const firstDirectorySector = bytes.readUInt32LE(0x30);
	const miniCutoff = bytes.readUInt32LE(0x38);
	const firstMiniFatSector = bytes.readUInt32LE(0x3c);
	let difatSector = bytes.readUInt32LE(0x44);
	const sectorCount = Math.floor((bytes.length - sectorSize) / sectorSize);

	const sector = (index: number) => {
		if (index >= sectorCount) throw new SpreadsheetError('The file is damaged.');
		const start = (index + 1) * sectorSize;
		return bytes.subarray(start, start + sectorSize);
	};

	// The sectors that hold the allocation table: 109 listed in the header, the rest
	// in a chain of extra sectors.
	const fatSectors: number[] = [];
	for (let i = 0; i < 109 && fatSectors.length < fatSectorCount; i++) {
		fatSectors.push(bytes.readUInt32LE(0x4c + i * 4));
	}
	for (let guard = 0; fatSectors.length < fatSectorCount && difatSector < END_OF_CHAIN; guard++) {
		if (guard > sectorCount) throw new SpreadsheetError('The file is damaged.');
		const data = sector(difatSector);
		const perSector = sectorSize / 4 - 1;
		for (let i = 0; i < perSector && fatSectors.length < fatSectorCount; i++) {
			fatSectors.push(data.readUInt32LE(i * 4));
		}
		difatSector = data.readUInt32LE(perSector * 4);
	}
	const fat: number[] = [];
	for (const index of fatSectors) {
		const data = sector(index);
		for (let i = 0; i < sectorSize; i += 4) fat.push(data.readUInt32LE(i));
	}

	const chain = (start: number, table: number[], limit: number) => {
		const out: number[] = [];
		for (let next = start; next !== END_OF_CHAIN && next !== FREE; next = table[next]) {
			if (next >= table.length || out.length > limit)
				throw new SpreadsheetError('The file is damaged.');
			out.push(next);
		}
		return out;
	};
	const readChain = (start: number) =>
		Buffer.concat(chain(start, fat, sectorCount).map((index) => sector(index)));

	// Directory entries are 128 bytes: a UTF-16 name, a type, a start, and a size.
	const directory = readChain(firstDirectorySector);
	const entries: { name: string; type: number; start: number; size: number }[] = [];
	for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
		const nameLength = directory.readUInt16LE(offset + 0x40);
		entries.push({
			name: directory.toString('utf16le', offset, offset + Math.max(0, nameLength - 2)),
			type: directory[offset + 0x42],
			start: directory.readUInt32LE(offset + 0x74),
			size: directory.readUInt32LE(offset + 0x78)
		});
	}
	const root = entries.find((entry) => entry.type === 5);
	const stream = entries.find((entry) => entry.type === 2 && names.includes(entry.name));
	if (!root || !stream) throw new SpreadsheetError('This is not an Excel workbook.');
	if (stream.size > MAX_UNPACKED_BYTES) throw new SpreadsheetError('The sheet is too large.');

	if (stream.size >= miniCutoff) return readChain(stream.start).subarray(0, stream.size);

	// A small stream lives in 64-byte mini sectors inside the root entry's stream.
	const miniStream = readChain(root.start);
	const miniFatBytes =
		firstMiniFatSector < END_OF_CHAIN ? readChain(firstMiniFatSector) : Buffer.alloc(0);
	const miniFat: number[] = [];
	for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(miniFatBytes.readUInt32LE(i));
	const parts = chain(stream.start, miniFat, miniStream.length / miniSectorSize).map((index) =>
		miniStream.subarray(index * miniSectorSize, (index + 1) * miniSectorSize)
	);
	return Buffer.concat(parts).subarray(0, stream.size);
}

// ---------------------------------------------------------------- BIFF8 workbook

const BOF = 0x0809;
const EOF = 0x000a;
const CONTINUE = 0x003c;
const SST = 0x00fc;
const LABELSST = 0x00fd;
const LABEL = 0x0204;
const NUMBER = 0x0203;
const RK = 0x027e;
const MULRK = 0x00bd;
const FORMULA = 0x0006;
const STRING = 0x0207;

interface BiffRecord {
	type: number;
	data: Buffer;
	/** The CONTINUE records that follow it, which a string may run into. */
	continues: Buffer[];
}

function biffRecords(stream: Buffer): BiffRecord[] {
	const list: BiffRecord[] = [];
	for (let offset = 0; offset + 4 <= stream.length;) {
		const type = stream.readUInt16LE(offset);
		const length = stream.readUInt16LE(offset + 2);
		const data = stream.subarray(offset + 4, offset + 4 + length);
		offset += 4 + length;
		if (type === CONTINUE && list.length > 0) list[list.length - 1].continues.push(data);
		else list.push({ type, data, continues: [] });
	}
	return list;
}

/** An RK number: a compact form of an integer or a double, optionally divided by 100. */
function rkValue(rk: number): number {
	let value: number;
	if (rk & 2) {
		value = rk >> 2;
	} else {
		const buffer = Buffer.alloc(8);
		buffer.writeUInt32LE(rk & 0xfffffffc, 4);
		value = buffer.readDoubleLE(0);
	}
	return rk & 1 ? value / 100 : value;
}

/**
 * Reads strings that may run on from one record into its CONTINUE records. A
 * string's characters restart each continuation with a fresh byte saying whether
 * they are one or two bytes wide.
 */
class StringReader {
	private parts: Buffer[];
	private part = 0;
	private offset = 0;
	constructor(parts: Buffer[]) {
		this.parts = parts;
	}

	private get current() {
		return this.parts[this.part];
	}

	private ensure() {
		while (this.part < this.parts.length && this.offset >= this.current.length) {
			this.part++;
			this.offset = 0;
		}
		if (this.part >= this.parts.length) throw new SpreadsheetError('The file is damaged.');
	}

	get done() {
		return (
			this.part >= this.parts.length ||
			(this.part === this.parts.length - 1 && this.offset >= this.current.length)
		);
	}

	u8() {
		this.ensure();
		return this.current[this.offset++];
	}

	u16() {
		return this.u8() | (this.u8() << 8);
	}

	u32() {
		return (this.u16() | (this.u16() << 16)) >>> 0;
	}

	skip(count: number) {
		for (let left = count; left > 0;) {
			this.ensure();
			const step = Math.min(left, this.current.length - this.offset);
			this.offset += step;
			left -= step;
		}
	}

	/** An XLUnicodeRichExtendedString: length, flags, characters, then formatting runs. */
	string() {
		const length = this.u16();
		const flags = this.u8();
		let wide = (flags & 1) === 1;
		const runs = flags & 8 ? this.u16() : 0;
		const extra = flags & 4 ? this.u32() : 0;
		let text = '';
		while (text.length < length) {
			if (this.offset >= this.current.length) {
				this.part++;
				this.offset = 0;
				if (this.part >= this.parts.length) throw new SpreadsheetError('The file is damaged.');
				wide = (this.current[this.offset++] & 1) === 1;
			}
			const available = Math.floor((this.current.length - this.offset) / (wide ? 2 : 1));
			const take = Math.min(length - text.length, available);
			const end = this.offset + take * (wide ? 2 : 1);
			text += this.current.toString(wide ? 'utf16le' : 'latin1', this.offset, end);
			this.offset = end;
			if (take === 0 && available === 0 && this.offset < this.current.length) {
				// A lone byte of a two-byte character can't be split; treat as damage.
				throw new SpreadsheetError('The file is damaged.');
			}
		}
		this.skip(runs * 4 + extra);
		return text;
	}
}

function readBiff(stream: Buffer): Grid {
	const list = biffRecords(stream);
	let strings: string[] = [];
	let index = 0;

	// The workbook globals come first: they hold the shared strings.
	if (list[0]?.type !== BOF) throw new SpreadsheetError('This is not an Excel workbook.');
	for (index = 1; index < list.length && list[index].type !== EOF; index++) {
		const record = list[index];
		if (record.type === SST) {
			const reader = new StringReader([record.data, ...record.continues]);
			reader.u32();
			const unique = reader.u32();
			strings = [];
			for (let i = 0; i < unique && !reader.done; i++) strings.push(reader.string());
		}
	}

	// Then the first worksheet, from its BOF to its EOF.
	while (index < list.length && list[index].type !== BOF) index++;
	const grid: Grid = [];
	let pendingFormula: { row: number; column: number } | null = null;
	for (index++; index < list.length && list[index].type !== EOF; index++) {
		const { type, data } = list[index];
		if (data.length < 6 && type !== STRING) continue;
		const row = data.readUInt16LE(0);
		const column = data.readUInt16LE(2);
		switch (type) {
			case LABELSST: {
				const text = strings[data.readUInt32LE(6)];
				if (text !== undefined) setCell(grid, row, column, text);
				break;
			}
			case LABEL:
				setCell(grid, row, column, new StringReader([data.subarray(6)]).string());
				break;
			case NUMBER:
				setCell(grid, row, column, data.readDoubleLE(6));
				break;
			case RK:
				setCell(grid, row, column, rkValue(data.readUInt32LE(6)));
				break;
			case MULRK: {
				const last = data.readUInt16LE(data.length - 2);
				for (let c = column, at = 4; c <= last && at + 6 <= data.length - 2; c++, at += 6) {
					setCell(grid, row, c, rkValue(data.readUInt32LE(at + 2)));
				}
				break;
			}
			case FORMULA:
				// A cached text result follows in a STRING record; a number is inline.
				if (data.readUInt16LE(12) === 0xffff && data[6] === 0) {
					pendingFormula = { row, column };
				} else if (data.readUInt16LE(12) !== 0xffff) {
					setCell(grid, row, column, data.readDoubleLE(6));
				}
				break;
			case STRING:
				if (pendingFormula) {
					const text = new StringReader([data, ...list[index].continues]).string();
					setCell(grid, pendingFormula.row, pendingFormula.column, text);
					pendingFormula = null;
				}
				break;
		}
	}
	return grid;
}

// ---------------------------------------------------------------- zip and xlsx

/** The files of a zip archive, by name. */
function readZip(bytes: Buffer): Map<string, Buffer> {
	// The end-of-central-directory record is in the last 64 KB.
	let end = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
		if (bytes.readUInt32LE(i) === 0x06054b50) {
			end = i;
			break;
		}
	}
	if (end < 0) throw new SpreadsheetError('The file is damaged.');
	const count = bytes.readUInt16LE(end + 10);
	let offset = bytes.readUInt32LE(end + 16);
	const files = new Map<string, Buffer>();
	let unpacked = 0;
	for (let i = 0; i < count; i++) {
		if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
			throw new SpreadsheetError('The file is damaged.');
		}
		const method = bytes.readUInt16LE(offset + 10);
		const compressedSize = bytes.readUInt32LE(offset + 20);
		const size = bytes.readUInt32LE(offset + 24);
		const nameLength = bytes.readUInt16LE(offset + 28);
		const extraLength = bytes.readUInt16LE(offset + 30);
		const commentLength = bytes.readUInt16LE(offset + 32);
		const local = bytes.readUInt32LE(offset + 42);
		const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
		offset += 46 + nameLength + extraLength + commentLength;

		if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) {
			throw new SpreadsheetError('The file is damaged.');
		}
		const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
		const packed = bytes.subarray(start, start + compressedSize);
		unpacked += size;
		if (unpacked > MAX_UNPACKED_BYTES) throw new SpreadsheetError('The sheet is too large.');
		if (method === 0) files.set(name, packed);
		else if (method === 8)
			files.set(name, inflateRawSync(packed, { maxOutputLength: MAX_UNPACKED_BYTES }));
	}
	return files;
}

function decodeXml(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
		const lower = entity.toLowerCase();
		if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
		if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
		return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[lower]!;
	});
}

/** The text of every `<t>` inside an element, joined: a plain or a formatted string. */
function textOf(xml: string): string {
	return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
		.map((match) => decodeXml(match[1]))
		.join('');
}

/** A column's index from a cell reference such as `C12`. */
function columnIndex(reference: string): number {
	let index = 0;
	for (const char of reference.match(/^[A-Z]+/)?.[0] ?? '')
		index = index * 26 + char.charCodeAt(0) - 64;
	return index - 1;
}

function readXlsx(files: Map<string, Buffer>): Grid {
	const text = (name: string) => files.get(name)?.toString('utf8') ?? null;

	// The first sheet listed in the workbook, through its relationship.
	let sheetPath = 'xl/worksheets/sheet1.xml';
	const workbook = text('xl/workbook.xml');
	const relations = text('xl/_rels/workbook.xml.rels');
	const relationId = workbook?.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
	if (relationId && relations) {
		const relation = [...relations.matchAll(/<Relationship\b[^>]*>/g)]
			.map((match) => match[0])
			.find((tag) => tag.includes(`Id="${relationId}"`));
		const target = relation?.match(/Target="([^"]+)"/)?.[1];
		if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
	}
	const sheet = text(sheetPath);
	if (!sheet) throw new SpreadsheetError('This is not an Excel workbook.');

	const shared = [...(text('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
		(match) => textOf(match[1])
	);

	const grid: Grid = [];
	let nextRow = 0;
	for (const rowMatch of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
		const rowNumber = Number(rowMatch[1].match(/\br="(\d+)"/)?.[1] ?? nextRow + 1) - 1;
		nextRow = rowNumber + 1;
		let nextColumn = 0;
		for (const cell of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
			const attributes = cell[1];
			const reference = attributes.match(/\br="([A-Z]+)\d*"/)?.[1];
			const column = reference ? columnIndex(reference) : nextColumn;
			nextColumn = column + 1;
			const type = attributes.match(/\bt="(\w+)"/)?.[1] ?? 'n';
			const body = cell[2] ?? '';
			const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
			let value: Cell = '';
			if (type === 's' && raw !== undefined) value = shared[Number(raw)] ?? '';
			else if (type === 'inlineStr') value = textOf(body);
			else if ((type === 'str' || type === 'e') && raw !== undefined) value = decodeXml(raw);
			else if (type === 'n' && raw !== undefined && raw !== '') value = Number(raw);
			else if (raw !== undefined) value = decodeXml(raw);
			if (value !== '') setCell(grid, rowNumber, column, value);
		}
	}
	return grid;
}
