import assert from 'node:assert/strict';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const [name, value, expected] of [
	['absent', undefined, 'application/json'],
	['string', 'application/problem+json', 'application/problem+json'],
	['array', ['text/plain', 'application/json'], 'text/plain, application/json'],
	['empty string', '', ''],
	['number', 0, '0'],
] satisfies Array<[string, string | string[] | number | undefined, string]>) {
	test(`a late JSON shortcut uses the ${name} Accept header setting`, withServer, async (t, server, got) => {
		server.get('/', (request, response) => {
			response.json({accept: request.headers.accept});
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		t.after(() => {
			release.resolve();
		});
		const pending = got('', {
			headers: value === undefined ? {} : {accept: value},
			hooks: {
				beforeRequest: [async () => {
					entered.resolve();
					await release.promise;
				}],
			},
		});
		await entered.promise;
		const result = pending.json();
		release.resolve();
		assert.deepStrictEqual(await result, {accept: expected});
	});
}

test('deleting an omitted Accept header allows a late JSON shortcut to set its default', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.json({accept: request.headers.accept});
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	t.after(() => {
		release.resolve();
	});
	const pending = got('', {
		headers: {accept: undefined},
		hooks: {
			beforeRequest: [async options => {
				delete options.headers.accept;
				entered.resolve();
				await release.promise;
			}],
		},
	});
	await entered.promise;
	const result = pending.json();
	release.resolve();
	assert.deepStrictEqual(await result, {accept: 'application/json'});
});
