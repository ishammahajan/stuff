import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
	password: string,
	salt: Buffer,
	keyLength: number
) => Promise<Buffer>;

const KEY_LENGTH = 64;

/** Returns `salt:key`, both hex encoded. */
export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await scryptAsync(password, salt, KEY_LENGTH);
	return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	const [saltHex, keyHex] = hash.split(':');
	if (!saltHex || !keyHex) return false;
	const expected = Buffer.from(keyHex, 'hex');
	if (expected.length !== KEY_LENGTH) return false;
	const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
	return timingSafeEqual(actual, expected);
}
