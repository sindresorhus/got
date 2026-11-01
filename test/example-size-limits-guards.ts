import assert from 'node:assert/strict';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import runExample from './helpers/run-example.js';

const downloadUrl = '\'https://pop-iso.sfo2.cdn.digitaloceanspaces.com/21.04/amd64/intel/5/pop-os_21.04_amd64_intel_5.iso\'';

for (const {name, limit, size} of [
	{name: 'an exact download limit', limit: 20, size: 20},
	{name: 'a larger download limit', limit: 21, size: 20},
	{name: 'an empty download with a zero-byte limit', limit: 0, size: 0},
]) {
	test(`the size-limit example allows ${name}`, withServer, async (_t, server) => {
		server.post('/anything', (request, response) => {
			request.resume();
			response.json({headers: request.headers});
		});
		let downloads = 0;
		server.get('/download', (_request, response) => {
			downloads++;
			response.end('x'.repeat(size));
		});
		const stdout = await runExample('advanced-creation.js', [
			['\'https://httpbin.org/\'', JSON.stringify(`${server.url}/`)],
			[downloadUrl, JSON.stringify(`${server.url}/download`)],
			['const MEGABYTE = 1_048_576;', `const MEGABYTE = ${limit};`],
		]);
		assert.doesNotMatch(stdout, /Exceeded the download limit/v);
		assert.match(stdout, /sign: 'EB0167A1EBF205510BAFF5DA1465537944225F0E0140E1880B746F361FF11DCA'/v);
		assert.doesNotMatch(stdout, /user-agent/v);
		assert.strictEqual(downloads, 1);
	});
}

test('the size-limit example preserves a caller abort signal', withServer, async (_t, server) => {
	server.post('/anything', (request, response) => {
		request.resume();
		response.json({headers: request.headers});
	});
	let downloads = 0;
	server.get('/download', (_request, response) => {
		downloads++;
		response.end('body');
	});
	const stdout = await runExample('advanced-creation.js', [
		['\'https://httpbin.org/\'', JSON.stringify(`${server.url}/`)],
		[downloadUrl, JSON.stringify(`${server.url}/download`)],
		['prefixUrl: \'\',', 'prefixUrl: \'\', signal: AbortSignal.abort(),'],
	]);
	assert.match(stdout, /This operation was aborted/v);
	assert.strictEqual(downloads, 0);
});
