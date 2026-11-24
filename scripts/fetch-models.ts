// Downloads the embedding model that search by meaning uses, before each build.
// The files are too large for git, so they are fetched from Hugging Face at a pinned
// commit and checked against their SHA-256. Files already in place are kept.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// BAAI/bge-small-en-v1.5 (MIT licence), as converted to ONNX by Xenova.
const BASE =
	'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/ea104dacec62c0de699686887e3f920caeb4f3e3';

const FILES = [
	{
		url: `${BASE}/onnx/model_quantized.onnx`,
		path: 'models/bge-small-en-v1.5/model_quantized.onnx',
		sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4'
	},
	{
		url: `${BASE}/tokenizer.json`,
		path: 'models/bge-small-en-v1.5/tokenizer.json',
		sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66'
	}
];

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

for (const file of FILES) {
	const existing = await readFile(file.path).catch(() => null);
	if (existing && sha256(existing) === file.sha256) continue;

	const response = await fetch(file.url);
	if (!response.ok) throw new Error(`Downloading ${file.url} failed: ${response.status}`);
	const data = Buffer.from(await response.arrayBuffer());
	if (sha256(data) !== file.sha256) throw new Error(`${file.url} doesn't match its checksum.`);

	await mkdir(dirname(file.path), { recursive: true });
	// Written beside the file and renamed, so an interrupted download leaves no partial file.
	await writeFile(`${file.path}.part`, data);
	await rename(`${file.path}.part`, file.path);
	console.log(`Downloaded ${file.path}`);
}
