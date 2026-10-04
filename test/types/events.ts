import {expectTypeOf} from 'expect-type';
import got from '../../source/index.js';
import type {PlainResponse} from '../../source/core/response.js';
import type {Request} from '../../source/core/index.js';

// Stream responses are plain: `body` and `rawBody` are only parsed for the Promise API, so the
// event listeners must not promise them.
expectTypeOf<Parameters<Extract<Parameters<Request['on']>, (name: 'response', listener: (response: PlainResponse) => void) => unknown>>[1]>()
	.parameter(0)
	.toEqualTypeOf<PlainResponse>();

got.stream('https://example.com').on('response', response => {
	expectTypeOf(response).toEqualTypeOf<PlainResponse>();
});

got.stream('https://example.com').on('redirect', (nextOptions, response) => {
	expectTypeOf(response).toEqualTypeOf<PlainResponse>();
	expectTypeOf(nextOptions.url).toEqualTypeOf<URL | undefined>();
});
