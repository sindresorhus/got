import type {Buffer} from 'node:buffer';
import type {Spread} from 'type-fest';
import type {CancelableRequest} from './as-promise/types.js';
import type {Response} from './core/response.js';
import type Options from './core/options.js';
import {type PaginationOptions, type OptionsInit} from './core/options.js';
import type Request from './core/index.js';

// `type-fest` utilities
type Except<ObjectType, KeysType extends keyof ObjectType> = Pick<ObjectType, Exclude<keyof ObjectType, KeysType>>;
type Merge<FirstType, SecondType> = Except<FirstType, Extract<keyof FirstType, keyof SecondType>> & SecondType;

/**
Defaults for each Got instance.
*/
export type InstanceDefaults = {
	/**
	An object containing the default options of Got.
	*/
	options: Options;

	/**
	An array of functions. You execute them directly by calling `got()`.
	They are some sort of "global hooks" - these functions are called first.
	The last handler (*it's hidden*) is either `asPromise` or `asStream`, depending on the `options.isStream` property.

	@default []
	*/
	handlers: HandlerFunction[];

	/**
	A read-only boolean describing whether the defaults are mutable or not.
	If set to `true`, you can update headers over time, for example, update an access token when it expires.

	@default false
	*/
	mutableDefaults: boolean;
};

/**
A Request object returned by calling Got, or any of the Got HTTP alias request functions.
*/
export type GotReturn = Request | CancelableRequest;

/**
A function to handle options and returns a Request object.
It acts sort of like a "global hook", and will be called before any actual request is made.
*/
export type HandlerFunction = <T extends GotReturn>(options: Options, next: (options: Options) => T) => T | Promise<T>;

/**
The options available for `got.extend()`.
*/
export type ExtendOptions = {
	/**
	An array of functions. You execute them directly by calling `got()`.
	They are some sort of "global hooks" - these functions are called first.
	The last handler (*it's hidden*) is either `asPromise` or `asStream`, depending on the `options.isStream` property.

	@default []
	*/
	handlers?: HandlerFunction[];

	/**
	A read-only boolean describing whether the defaults are mutable or not.
	If set to `true`, you can update headers over time, for example, update an access token when it expires.

	@default false
	*/
	mutableDefaults?: boolean;
} & OptionsInit;

export type StrictOptions = Except<OptionsInit, 'isStream' | 'responseType' | 'resolveBodyOnly'>;
export type StreamOptions = Merge<OptionsInit, {isStream?: true}>;

export type OptionsWithPagination<T = unknown, R = unknown> = Merge<OptionsInit, {pagination?: PaginationOptions<T, R>}>;

/**
An instance of `got.paginate`.
*/
export type GotPaginate = {
	/**
	Same as `GotPaginate.each`.
	*/
	<T, R = unknown>(url: string | URL, options?: OptionsWithPagination<T, R>): AsyncIterableIterator<T>;

	/**
	Same as `GotPaginate.each`.
	*/
	<T, R = unknown>(options?: OptionsWithPagination<T, R>): AsyncIterableIterator<T>;

	/**
	Returns an async iterator.

	See pagination.options for more pagination options.

	@example
	```
	import got from 'got';

	const countLimit = 10;

	const pagination = got.paginate('https://api.github.com/repos/sindresorhus/got/commits', {
		pagination: {countLimit}
	});

	console.log(`Printing latest ${countLimit} Got commits (newest to oldest):`);

	for await (const commitData of pagination) {
		console.log(commitData.commit.message);
	}
	```
	*/
	each: (<T, R = unknown>(url: string | URL, options?: OptionsWithPagination<T, R>) => AsyncIterableIterator<T>)
	& (<T, R = unknown>(options?: OptionsWithPagination<T, R>) => AsyncIterableIterator<T>);

	/**
	Returns a Promise for an array of all results.

	See pagination.options for more pagination options.

	@example
	```
	import got from 'got';

	const countLimit = 10;

	const results = await got.paginate.all('https://api.github.com/repos/sindresorhus/got/commits', {
		pagination: {countLimit}
	});

	console.log(`Printing latest ${countLimit} Got commits (newest to oldest):`);
	console.log(results);
	```
	*/
	all: (<T, R = unknown>(url: string | URL, options?: OptionsWithPagination<T, R>) => Promise<T[]>)
	& (<T, R = unknown>(options?: OptionsWithPagination<T, R>) => Promise<T[]>);
};

export type OptionsOfTextResponseBody = Merge<StrictOptions, {isStream?: false; responseType?: 'text'}>;
export type OptionsOfTextResponseBodyOnly = Merge<StrictOptions, {isStream?: false; resolveBodyOnly: true; responseType?: 'text'}>;
export type OptionsOfTextResponseBodyWrapped = Merge<StrictOptions, {isStream?: false; resolveBodyOnly: false; responseType?: 'text'}>;

export type OptionsOfJSONResponseBody = Merge<StrictOptions, {isStream?: false; responseType?: 'json'}>; // eslint-disable-line @typescript-eslint/naming-convention
export type OptionsOfJSONResponseBodyOnly = Merge<StrictOptions, {isStream?: false; resolveBodyOnly: true; responseType?: 'json'}>; // eslint-disable-line @typescript-eslint/naming-convention
export type OptionsOfJSONResponseBodyWrapped = Merge<StrictOptions, {isStream?: false; resolveBodyOnly: false; responseType?: 'json'}>; // eslint-disable-line @typescript-eslint/naming-convention

export type OptionsOfBufferResponseBody = Merge<StrictOptions, {isStream?: false; responseType?: 'buffer'}>;
export type OptionsOfBufferResponseBodyOnly = Merge<StrictOptions, {isStream?: false; resolveBodyOnly: true; responseType?: 'buffer'}>;
export type OptionsOfBufferResponseBodyWrapped = Merge<StrictOptions, {isStream?: false; resolveBodyOnly: false; responseType?: 'buffer'}>;

export type OptionsOfUnknownResponseBody = Merge<StrictOptions, {isStream?: false}>;
export type OptionsOfUnknownResponseBodyOnly = Merge<StrictOptions, {isStream?: false; resolveBodyOnly: true}>;
export type OptionsOfUnknownResponseBodyWrapped = Merge<StrictOptions, {isStream?: false; resolveBodyOnly: false}>;

export type GotRequestFunction<U extends ExtendOptions = Record<string, unknown>> = {
	// `asPromise` usage
	(url: string | URL, options?: OptionsOfTextResponseBody): U['resolveBodyOnly'] extends true ? CancelableRequest<string> : CancelableRequest<Response<string>>;
	<T>(url: string | URL, options?: OptionsOfJSONResponseBody): U['resolveBodyOnly'] extends true ? CancelableRequest<T> : CancelableRequest<Response<T>>;
	(url: string | URL, options?: OptionsOfBufferResponseBody): U['resolveBodyOnly'] extends true ? CancelableRequest<Buffer> : CancelableRequest<Response<Buffer>>;
	(url: string | URL, options?: OptionsOfUnknownResponseBody): U['resolveBodyOnly'] extends true ? CancelableRequest : CancelableRequest<Response>;

	(url: string | URL, options?: OptionsOfTextResponseBodyWrapped): CancelableRequest<Response<string>>;
	<T>(url: string | URL, options?: OptionsOfJSONResponseBodyWrapped): CancelableRequest<Response<T>>;
	(url: string | URL, options?: OptionsOfBufferResponseBodyWrapped): CancelableRequest<Response<Buffer>>;
	(url: string | URL, options?: OptionsOfUnknownResponseBodyWrapped): CancelableRequest<Response>;

	(url: string | URL, options?: OptionsOfTextResponseBodyOnly): CancelableRequest<string>;
	<T>(url: string | URL, options?: OptionsOfJSONResponseBodyOnly): CancelableRequest<T>;
	(url: string | URL, options?: OptionsOfBufferResponseBodyOnly): CancelableRequest<Buffer>;
	(url: string | URL, options?: OptionsOfUnknownResponseBodyOnly): CancelableRequest;

	(options: OptionsOfTextResponseBody): U['resolveBodyOnly'] extends true ? CancelableRequest<string> : CancelableRequest<Response<string>>;
	<T>(options: OptionsOfJSONResponseBody): U['resolveBodyOnly'] extends true ? CancelableRequest<T> : CancelableRequest<Response<T>>;
	(options: OptionsOfBufferResponseBody): U['resolveBodyOnly'] extends true ? CancelableRequest<Buffer> : CancelableRequest<Response<Buffer>>;
	(options: OptionsOfUnknownResponseBody): U['resolveBodyOnly'] extends true ? CancelableRequest : CancelableRequest<Response>;

	(options: OptionsOfTextResponseBodyWrapped): CancelableRequest<Response<string>>;
	<T>(options: OptionsOfJSONResponseBodyWrapped): CancelableRequest<Response<T>>;
	(options: OptionsOfBufferResponseBodyWrapped): CancelableRequest<Response<Buffer>>;
	(options: OptionsOfUnknownResponseBodyWrapped): CancelableRequest<Response>;

	(options: OptionsOfTextResponseBodyOnly): CancelableRequest<string>;
	<T>(options: OptionsOfJSONResponseBodyOnly): CancelableRequest<T>;
	(options: OptionsOfBufferResponseBodyOnly): CancelableRequest<Buffer>;
	(options: OptionsOfUnknownResponseBodyOnly): CancelableRequest;

	// `asStream` usage
	(url: string | URL, options?: Merge<OptionsInit, {isStream: true}>): Request;

	(options: Merge<OptionsInit, {isStream: true}>): Request;

	// Fallback
	(url: string | URL, options?: OptionsInit): CancelableRequest | Request;

	(options: OptionsInit): CancelableRequest | Request;

	// Internal usage
	(url: undefined, options: undefined, defaults: Options): CancelableRequest | Request;
};

/**
All available HTTP request methods provided by Got.
*/
// eslint-disable-next-line @typescript-eslint/naming-convention
export type HTTPAlias =
	| 'get'
	| 'post'
	| 'put'
	| 'patch'
	| 'head'
	| 'delete';

type GotStreamFunction =
	((url?: string | URL, options?: Merge<OptionsInit, {isStream?: true}>) => Request) &
	((options?: Merge<OptionsInit, {isStream?: true}>) => Request);

/**
An instance of `got.stream()`.
*/
export type GotStream = GotStreamFunction & Record<HTTPAlias, GotStreamFunction>;

/**
An instance of `got`.
*/
export type Got<GotOptions extends ExtendOptions = ExtendOptions> = {
	/**
	Sets `options.isStream` to `true`.

	Returns a [duplex stream](https://nodejs.org/api/stream.html#stream_class_stream_duplex) with additional events:
	- request
	- response
	- redirect
	- uploadProgress
	- downloadProgress
	- error
	*/
	stream: GotStream;

	/**
	Returns an async iterator.

	See pagination.options for more pagination options.

	@example
	```
	import got from 'got';

	const countLimit = 10;

	const pagination = got.paginate('https://api.github.com/repos/sindresorhus/got/commits', {
		pagination: {countLimit}
	});

	console.log(`Printing latest ${countLimit} Got commits (newest to oldest):`);

	for await (const commitData of pagination) {
		console.log(commitData.commit.message);
	}
	```
	*/
	paginate: GotPaginate;

	/**
	The Got defaults used in that instance.
	*/
	defaults: InstanceDefaults;

	/**
	Configure a new `got` instance with default `options`.
	The `options` are merged with the parent instance's `defaults.options` using `got.mergeOptions`.
	You can access the resolved options with the `.defaults` property on the instance.

	Additionally, `got.extend()` accepts two properties from the `defaults` object: `mutableDefaults` and `handlers`.

	It is also possible to merges many instances into a single one:
	- options are merged using `got.mergeOptions()` (including hooks),
	- handlers are stored in an array (you can access them through `instance.defaults.handlers`).

	@example
	```
	import got from 'got';

	const client = got.extend({
		prefixUrl: 'https://example.com',
		headers: {
			'x-unicorn': 'rainbow'
		}
	});

	client.get('demo');

	// HTTP Request =>
	// GET /demo HTTP/1.1
	// Host: example.com
	// x-unicorn: rainbow
	```
	*/
	extend<T extends Array<Got | ExtendOptions>>(...instancesOrOptions: T): Got<MergeExtendsConfig<T>>;
}
& Record<HTTPAlias, GotRequestFunction<GotOptions>>
& GotRequestFunction<GotOptions>;

export type ExtractExtendOptions<T> = T extends Got<infer GotOptions>
	? GotOptions
	: T;

/**
Merges the options of multiple Got instances.
*/
export type MergeExtendsConfig<Value extends Array<Got | ExtendOptions>> =
Value extends readonly [Value[0], ...infer NextValue]
	? NextValue[0] extends undefined
		? Value[0] extends infer OnlyValue
			? OnlyValue extends ExtendOptions
				? OnlyValue
				: OnlyValue extends Got<infer GotOptions>
					? GotOptions
					: OnlyValue
			: never
		: ExtractExtendOptions<Value[0]> extends infer FirstArg extends ExtendOptions
			? ExtractExtendOptions<NextValue[0] extends ExtendOptions | Got ? NextValue[0] : never> extends infer NextArg extends ExtendOptions
				? Spread<FirstArg, NextArg> extends infer Merged extends ExtendOptions
					? NextValue extends [NextValue[0], ...infer NextRest]
						? NextRest extends Array<Got | ExtendOptions>
							? MergeExtendsConfig<[Merged, ...NextRest]>
							: never
						: never
					: never
				: never
			: never
	: never;
