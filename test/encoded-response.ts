import {Buffer} from 'node:buffer';
import test from 'ava';
import ResponseLike from 'responselike';
import got from '../source/index.js';

for (const encoding of ['utf8', 'latin1', 'utf16le'] as const) {
	for (const useCookieJar of [false, true]) {
		test(`preserves bytes from a custom response decoded as ${encoding} with cookie jar ${useCookieJar}`, async t => {
			const bytes = Buffer.from('café', encoding);
			const response = await got('https://example.com', {
				encoding,
				cookieJar: useCookieJar
					? {
						async getCookieString() {
							return '';
						},
						async setCookie() {},
					}
					: undefined,
				hooks: {
					beforeRequest: [() => {
						const response = new ResponseLike({
							statusCode: 200,
							headers: {'content-length': String(bytes.length)},
							body: bytes,
							url: 'https://example.com',
						});
						Object.assign(response.headers, {'set-cookie': ['session=value']});
						response.setEncoding(encoding);
						return response;
					}],
				},
			});

			t.is(response.body, 'café');
			t.deepEqual(response.rawBody, new Uint8Array(bytes));
			t.is(response.request.downloadProgress.transferred, bytes.length);
		});
	}
}
