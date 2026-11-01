import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import type {OptionsInit} from '../source/index.js';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';

for (const phase of ['afterResponse', 'pagination'] as const) {
	test(`${phase} uses one headers snapshot for a cross-origin follow-up`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.json(['source']);
		});
		await withServer(t, async (_t, destination) => {
			destination.get('/', (request, response) => {
				response.json([request.headers.authorization ?? '']);
			});
			let headerReads = 0;
			const updatedOptions: OptionsInit = {
				url: destination.url,
				get headers() {
					headerReads++;
					return headerReads === 1 ? {authorization: 'Bearer destination'} : {};
				},
			};
			if (phase === 'afterResponse') {
				const body = await got('', {
					hooks: {afterResponse: [(_response, retry) => retry(updatedOptions)]},
				}).json();
				assert.deepStrictEqual(body, ['Bearer destination']);
			} else {
				let pages = 0;
				const items = await got.paginate.all('', {
					responseType: 'json',
					pagination: {paginate: () => ++pages === 1 ? updatedOptions : false},
				});
				assert.deepStrictEqual(items, ['source', 'Bearer destination']);
			}

			assert.strictEqual(headerReads, 1);
		});
	});
}

for (const phase of ['afterResponse', 'pagination'] as const) {
	test(`${phase} snapshots the URL, replacement payload, and credentials before follow-up decisions`, withServer, async (t, server, got) => {
		server.post('/', async (request, response) => {
			await request.toArray();
			response.json(['source']);
		});
		await withServer(t, async (_t, destination) => {
			destination.post('/next', async (request, response) => {
				const chunks = await request.toArray();
				response.json([{body: Buffer.concat(chunks).toString(), authorization: request.headers.authorization}]);
			});
			const reads = {
				url: 0, body: 0, username: 0, password: 0,
			};
			const updatedOptions: OptionsInit = {
				method: 'POST',
				get url() {
					return ++reads.url === 1 ? `${destination.url}/next` : server.url;
				},
				get body() {
					return ++reads.body === 1 ? 'destination payload' : undefined;
				},
				get username() {
					return ++reads.username === 1 ? 'destination-user' : 'source-user';
				},
				get password() {
					return ++reads.password === 1 ? 'destination-password' : 'source-password';
				},
			};
			const expected = {body: 'destination payload', authorization: `Basic ${Buffer.from('destination-user:destination-password').toString('base64')}`};
			if (phase === 'afterResponse') {
				assert.deepStrictEqual(await got.post('', {
					body: 'source payload',
					hooks: {afterResponse: [(_response, retry) => retry(updatedOptions)]},
				}).json(), [expected]);
			} else {
				let pages = 0;
				assert.deepStrictEqual(await got.paginate.all('', {
					method: 'POST', body: 'source payload', responseType: 'json',
					pagination: {paginate: () => ++pages === 1 ? updatedOptions : false},
				}), ['source', expected]);
			}

			assert.deepStrictEqual(reads, {
				url: 1, body: 1, username: 1, password: 1,
			});
		});
	});
}

test('an afterResponse retry reads its preserveHooks control once with the rest of its options', withServer, async (_t, server, got) => {
	let requests = 0;
	server.get('/', (_request, response) => {
		requests++;
		response.json({attempt: requests});
	});
	let controlReads = 0;
	let hooks = 0;
	const body = await got('', {
		hooks: {
			afterResponse: [(response, retry) => {
				hooks++;
				if (hooks === 1) {
					return retry({
						get preserveHooks() {
							return ++controlReads === 1;
						},
					});
				}

				return response;
			}],
		},
	}).json();
	assert.deepStrictEqual(body, {attempt: 2});
	assert.strictEqual(hooks, 2);
	assert.strictEqual(controlReads, 1);
});

for (const phase of ['afterResponse', 'pagination'] as const) {
	test(`${phase} retains an own non-enumerable follow-up URL`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.json(['source']);
		});
		await withServer(t, async (_t, destination) => {
			destination.get('/', (_request, response) => {
				response.json(['destination']);
			});
			let urlReads = 0;
			const updatedOptions: OptionsInit = {};
			Object.defineProperty(updatedOptions, 'url', {
				get() {
					urlReads++;
					return destination.url;
				},
			});
			if (phase === 'afterResponse') {
				assert.deepStrictEqual(await got('', {
					hooks: {afterResponse: [(_response, retry) => retry(updatedOptions)]},
				}).json(), ['destination']);
			} else {
				let pages = 0;
				assert.deepStrictEqual(await got.paginate.all('', {
					responseType: 'json',
					pagination: {paginate: () => ++pages === 1 ? updatedOptions : false},
				}), ['source', 'destination']);
			}

			assert.strictEqual(urlReads, 1);
		});
	});
}

test('an afterResponse retry retains its own non-enumerable preserveHooks control', withServer, async (_t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('retried');
	});
	let hooks = 0;
	let controlReads = 0;
	const updatedOptions: OptionsInit = {};
	Object.defineProperty(updatedOptions, 'preserveHooks', {
		get() {
			controlReads++;
			return true;
		},
	});
	assert.strictEqual(await got('', {
		hooks: {
			afterResponse: [(response, retry) => ++hooks === 1 ? retry(updatedOptions) : response],
		},
	}).text(), 'retried');
	assert.strictEqual(hooks, 2);
	assert.strictEqual(controlReads, 1);
});
