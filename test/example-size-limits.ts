import assert from 'node:assert/strict';
import test from './helpers/test.js';
import withServer from './helpers/with-server.js';
import runExample from './helpers/run-example.js';

const downloadUrl = '\'https://pop-iso.sfo2.cdn.digitaloceanspaces.com/21.04/amd64/intel/5/pop-os_21.04_amd64_intel_5.iso\'';

for (const {name, limit, chunked, signal, stream} of [
	{
		name: 'a complete response chunk', limit: 10, chunked: false, signal: false, stream: false,
	},
	{
		name: 'a zero-byte limit', limit: 0, chunked: true, signal: false, stream: false,
	},
	{
		name: 'a caller-provided signal', limit: 10, chunked: true, signal: true, stream: false,
	},
	{
		name: 'a complete response chunk through the stream API', limit: 10, chunked: false, signal: false, stream: true,
	},
]) {
	test(`the size-limit example rejects downloads with ${name}`, withServer, async (_t, server) => {
		server.post('/anything', (request, response) => {
			request.resume();
			response.json({headers: request.headers});
		});
		server.get('/download', (_request, response) => {
			if (chunked) {
				response.write('x'.repeat(20));
				response.end();
			} else {
				response.end('x'.repeat(20));
			}
		});
		const stdout = await runExample('advanced-creation.js', [
			['\'https://httpbin.org/\'', JSON.stringify(`${server.url}/`)],
			[downloadUrl, JSON.stringify(`${server.url}/download`)],
			['const MEGABYTE = 1_048_576;', `const MEGABYTE = ${limit};`],
			...(signal ? [['prefixUrl: \'\',', 'prefixUrl: \'\', signal: new AbortController().signal,'] as const] : []),
			...(stream
				? [
					['await merged(', 'await Array.fromAsync(merged.stream('] as const,
					['prefixUrl: \'\',\n\t});', 'prefixUrl: \'\',\n\t}));'] as const,
				]
				: []),
		]);
		assert.match(stdout, new RegExp(`Exceeded the download limit of ${limit} bytes`, 'v'));
	});
}

test('the size-limit example rejects a complete upload chunk', withServer, async (_t, server) => {
	server.post('/anything', (request, response) => {
		request.resume();
		response.json({headers: request.headers});
	});
	server.get('/download', (_request, response) => {
		response.end();
	});
	await assert.rejects(runExample('advanced-creation.js', [
		['\'https://httpbin.org/\'', JSON.stringify(`${server.url}/`)],
		[downloadUrl, JSON.stringify(`${server.url}/download`)],
		['secret: \'password\',', 'secret: \'password\', uploadLimit: 3,'],
	]), {message: /Exceeded the upload limit of 3 bytes/v});
});
