import {Buffer} from 'node:buffer';
import test from 'ava';
import withServer from './helpers/with-server.js';

for (const responseType of ['text', 'buffer'] as const) {
	for (const leadingBom of [false, true]) {
		test(`pagination handles UTF-16LE ${responseType} responses with leading BOM ${leadingBom}`, withServer, async (t, server, got) => {
			server.get('/', (_request, response) => {
				const body = `${leadingBom ? '﻿' : ''}["café"]`;
				response.end(Buffer.from(body, 'utf16le'));
			});

			const items = await got.paginate.all<string>('', {encoding: 'utf16le', responseType});

			t.deepEqual(items, ['café']);
		});
	}

	test(`UTF-16LE ${responseType} pagination rejects a second leading BOM`, withServer, async (t, server, got) => {
		server.get('/', (_request, response) => {
			response.end(Buffer.from('﻿﻿["café"]', 'utf16le'));
		});

		await t.throwsAsync(got.paginate.all('', {encoding: 'utf16le', responseType}), {instanceOf: SyntaxError});
	});
}

test('UTF-16LE buffer pagination decodes each linked page', withServer, async (t, server, got) => {
	server.get('/first', (_request, response) => {
		response.setHeader('link', '</next>; rel="next"');
		response.end(Buffer.from('﻿["café"]', 'utf16le'));
	});
	server.get('/next', (_request, response) => {
		response.end(Buffer.from('﻿["世界"]', 'utf16le'));
	});

	const items = await got.paginate.all<string>('first', {encoding: 'utf16le', responseType: 'buffer'});

	t.deepEqual(items, ['café', '世界']);
});
