// Encryption for user data. Kept free of SvelteKit imports so scripts can use it.
//
// Each user has a random data key. User content is encrypted with it using
// AES-256-GCM. The data key itself is only ever stored wrapped (encrypted) by a key
// derived from the user's password, their recovery code, or a session token.
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	hkdfSync,
	randomBytes,
	scrypt,
	type ScryptOptions
} from 'node:crypto';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const KEY_BYTES = 32;
export const SALT_BYTES = 16;

// About 32 MiB of memory and roughly 100 ms per derivation.
const SCRYPT_OPTIONS: ScryptOptions = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function randomKey(): Buffer {
	return randomBytes(KEY_BYTES);
}

export function randomSalt(): Buffer {
	return randomBytes(SALT_BYTES);
}

/**
 * Encrypts with AES-256-GCM. `context` names what is encrypted, for example
 * `captures:<id>:audio`. Decryption needs the same context, so a ciphertext can't
 * be copied to another row or column and still decrypt.
 * The result is: version (1 byte), IV (12 bytes), tag (16 bytes), ciphertext.
 */
export function encrypt(key: Buffer, plaintext: Buffer, context: string): Buffer {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(Buffer.from(context, 'utf8'));
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

/** Reverses `encrypt`. Throws if the key or context is wrong or the data was altered. */
export function decrypt(key: Buffer, data: Buffer, context: string): Buffer {
	if (data.length < 1 + IV_BYTES + TAG_BYTES || data[0] !== VERSION) {
		throw new Error('Unsupported encrypted data.');
	}
	const iv = data.subarray(1, 1 + IV_BYTES);
	const tag = data.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
	const decipher = createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAAD(Buffer.from(context, 'utf8'));
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(data.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]);
}

export function encryptJson(key: Buffer, value: unknown, context: string): Buffer {
	return encrypt(key, Buffer.from(JSON.stringify(value), 'utf8'), context);
}

export function decryptJson<T>(key: Buffer, data: Buffer, context: string): T {
	return JSON.parse(decrypt(key, data, context).toString('utf8')) as T;
}

/** Derives a key from a password or recovery code. Slow on purpose. */
export function keyFromSecret(secret: string, salt: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(secret.normalize('NFKC'), salt, KEY_BYTES, SCRYPT_OPTIONS, (error, key) =>
			error ? reject(error) : resolve(key)
		);
	});
}

/** Derives a key from a session token. Tokens are random, so a fast derivation is enough. */
export function keyFromToken(token: string): Buffer {
	return Buffer.from(hkdfSync('sha256', token, Buffer.alloc(0), 'stuff session key', KEY_BYTES));
}

export function sha256Hex(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

export function randomToken(): string {
	return randomBytes(32).toString('base64url');
}

// Crockford base32 without I, L, O, and U, so codes are easy to read and type.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_CODE_LENGTH = 25; // 125 bits.

/** Returns a recovery code such as `7K2QH-9XW4M-...`, five groups of five. */
export function randomRecoveryCode(): string {
	// 32 divides 256, so taking the low five bits of each byte is uniform.
	const chars = [...randomBytes(RECOVERY_CODE_LENGTH)].map((byte) => ALPHABET[byte & 31]);
	return chars.join('').match(/.{5}/g)!.join('-');
}

/** Normalizes typed input to the canonical form, or returns null if it can't be a code. */
export function normalizeRecoveryCode(input: string): string | null {
	const chars = input
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, '')
		.replace(/O/g, '0')
		.replace(/[IL]/g, '1');
	if (chars.length !== RECOVERY_CODE_LENGTH || [...chars].some((c) => !ALPHABET.includes(c))) {
		return null;
	}
	return chars.match(/.{5}/g)!.join('-');
}
