import {expectTypeOf} from 'expect-type';
import got, {type Options} from '../../source/index.js';
import type {PlainResponse, Response} from '../../source/core/response.js';

// Stream responses are plain: `body` and `rawBody` are only parsed for the Promise API, so the
// event listeners must not promise them.
got.stream('https://example.com').on('response', (response: PlainResponse) => {
	expectTypeOf(response).toEqualTypeOf<PlainResponse>();
	expectTypeOf(response.rawBody).toEqualTypeOf<Uint8Array<ArrayBuffer> | undefined>();
});

got.stream('https://example.com').on('redirect', (nextOptions: Options, response: PlainResponse) => {
	expectTypeOf(response).toEqualTypeOf<PlainResponse>();
	expectTypeOf(nextOptions.url).toEqualTypeOf<URL | string | undefined>();
});

// @ts-expect-error The parsed body of a `Response` is not part of a stream event.
got.stream('https://example.com').on('response', (response: Response) => {});

// The promise API settles with the same plain shape on the event.
void got('https://example.com').once('response', (response: PlainResponse) => {
	expectTypeOf(response).toEqualTypeOf<PlainResponse>();
});
