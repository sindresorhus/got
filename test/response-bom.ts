import {Buffer} from 'node:buffer';
import test from 'ava';
import {CookieJar} from 'tough-cookie';
import {ParseError} from '../source/index.js';
import withServer from './helpers/with-server.js';

const payload = '﻿{"hello":"世界"}';

// eslint-disable-next-line unicorn/text-encoding-identifier-case -- Verify all supported UTF-8 aliases.
for (const encoding of [undefined, 'utf8', 'utf-8', 'UTF-8'] as const) {
	for (const shortcut of [false, true]) {
		test(`JSON parser preserves BOM with and without cookies: ${encoding ?? 'default'}, shortcut=${shortcut}`, withServer, async (t, server, got) => {
			server.get('/', (_request, response) => {
				response.setHeader('set-cookie', 'hello=world');
				response.end(payload);
			});

			const inputs: string[] = [];
			for (const cookieJar of [undefined, new CookieJar()]) {
				const options = {
					cookieJar,
					encoding: encoding as BufferEncoding | undefined,
					parseJson(text: string) {
						inputs.push(text);
						return JSON.parse(text.trimStart()) as unknown;
					},
				};
				const request = shortcut ? got(options).json() : got({...options, responseType: 'json', resolveBodyOnly: true});
				// eslint-disable-next-line no-await-in-loop -- Preserve parser input order for comparison.
				const body = await request;

				t.deepEqual(body, {hello: '世界'});
			}

			t.deepEqual(inputs, [payload, payload]);
		});
	}
}

for (const shortcut of [false, true]) {
	for (const useCookieJar of [false, true]) {
		test(`default JSON parser rejects BOM: cookies=${useCookieJar}, shortcut=${shortcut}`, withServer, async (t, server, got) => {
			server.get('/', (_request, response) => {
				response.setHeader('set-cookie', 'hello=world');
				response.end(payload);
			});

			const options = {cookieJar: useCookieJar ? new CookieJar() : undefined};
			await t.throwsAsync(shortcut ? got(options).json() : got({...options, responseType: 'json'}), {
				instanceOf: ParseError,
				code: 'ERR_BODY_PARSE_FAILURE',
			});
		});
	}
}

test('empty JSON response with cookies does not call the parser', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end();
	});

	const options = {
		cookieJar: new CookieJar(),
		parseJson() {
			t.fail('Empty bodies must not be parsed');
		},
	};

	t.is((await got({...options, responseType: 'json'})).body, '');
	t.is(await got(options).json(), '');
});

test('JSON parser preserves non-UTF-8 encoding with cookies', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('set-cookie', 'hello=world');
		response.end(Buffer.from(payload, 'utf16le'));
	});

	const inputs: string[] = [];
	const options = {
		cookieJar: new CookieJar(),
		encoding: 'utf16le' as const,
		parseJson(text: string) {
			inputs.push(text);
			return JSON.parse(text.trimStart()) as unknown;
		},
	};

	t.deepEqual((await got({...options, responseType: 'json'})).body, {hello: '世界'});
	t.deepEqual(await got(options).json(), {hello: '世界'});
	t.deepEqual(inputs, [payload, payload]);
});
