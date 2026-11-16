// Prints the APP_PASSWORD_HASH value for a password read from standard input,
// so the password stays out of shell history. Run with `pnpm hash-password`.
import { createInterface } from 'node:readline/promises';
import { hashPassword } from '../src/lib/server/password.ts';

const readline = createInterface({ input: process.stdin, output: process.stderr });
const password = await readline.question('Password: ');
readline.close();

if (password.length < 12) {
	console.error('Use at least 12 characters.');
	process.exit(1);
}

console.log(await hashPassword(password));
