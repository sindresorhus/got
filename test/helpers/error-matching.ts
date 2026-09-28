import assert from 'node:assert/strict';

/**
Builds the expectation passed to `assert.throws`/`assert.rejects` for a mixed expectation.

AVAs expectation object mixes `instanceOf` with plain properties, and `assert` has no matcher for
`instanceOf`: the object form compares it as a property, which fails for every real error, while the
class form drops the other keys. This combines both, so a class plus a message, code or name is
checked rather than silently reduced to one of them.

Each key is compared with `strictEqual`, which is what AVAs `message`, `code` and `name` matchers did.
*/
export function errorMatching(constructor: new (...arguments_: any[]) => unknown, properties: Record<string, unknown>) {
	return (error: unknown) => {
		assert.ok(error instanceof constructor, `Expected an instance of \`${constructor.name}\`, got \`${(error as any)?.constructor?.name}\``);

		for (const [key, value] of Object.entries(properties)) {
			const actual = (error as any)?.[key];

			// AVAs `message` and `name` matchers take a string, a regular expression or a function, so
			// a regular expression is tested rather than compared.
			if (value instanceof RegExp) {
				assert.match(String(actual), value, `Expected \`${key}\` to match`);
				continue;
			}

			if (typeof value === 'function') {
				assert.ok(value(actual), `Expected \`${key}\` to match`);
				continue;
			}

			assert.strictEqual(actual, value, `Expected \`${key}\` to match`);
		}

		return true;
	};
}

export default errorMatching;
