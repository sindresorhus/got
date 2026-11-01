import {expectTypeOf} from 'expect-type';
import type {
	DnsCacheLookup,
	HTTPError,
	MaxRedirectsError,
	ReadError,
	RequestErrorResponse,
} from '../../source/index.js';

// The docs tell users to implement a DNS cache with `lookup` and `clear(hostname?)`, so the
// contract type must be importable from the package root.
expectTypeOf<DnsCacheLookup['lookup']>().toBeFunction();
expectTypeOf<DnsCacheLookup['clear']>().toBeNullable();

// A decoder can fail before Got has captured the response bytes.
expectTypeOf<NonNullable<ReadError['response']>['rawBody']>().toEqualTypeOf<Uint8Array<ArrayBuffer> | undefined>();
expectTypeOf<ReadError['response']>().toEqualTypeOf<RequestErrorResponse | undefined>();
expectTypeOf<Pick<NonNullable<ReadError['response']>, 'body'>>().toEqualTypeOf<{body?: unknown}>();
expectTypeOf<NonNullable<ReadError['response']>['statusCode']>().toEqualTypeOf<number>();

// A status error remains the primary error if reading its response fails.
expectTypeOf<HTTPError<string>['response']['body']>().toEqualTypeOf<string | undefined>();
expectTypeOf<HTTPError['response']['rawBody']>().toEqualTypeOf<Uint8Array<ArrayBuffer> | undefined>();
expectTypeOf<MaxRedirectsError['response']['rawBody']>().toEqualTypeOf<Uint8Array<ArrayBuffer> | undefined>();
expectTypeOf<HTTPError['response']>().toEqualTypeOf<RequestErrorResponse>();
expectTypeOf<MaxRedirectsError['response']>().toEqualTypeOf<RequestErrorResponse>();
