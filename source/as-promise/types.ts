import PCancelable = require('p-cancelable');
import {CancelError} from 'p-cancelable';
import {
	// Interfaces to be extended
	Options as RequestOptions,
	NormalizedOptions as RequestNormalizedOptions,
	Defaults as RequestDefaults,
	Hooks as RequestHooks,
	Response as RequestResponse,

	// Errors to be exported
	RequestError,
	MaxRedirectsError,
	CacheError,
	UploadError,
	TimeoutError,
	HTTPError,
	ReadError,
	UnsupportedProtocolError,

	// Hooks to be exported
	HookEvent as RequestHookEvent,
	InitHook,
	BeforeRequestHook,
	BeforeRedirectHook,
	BeforeErrorHook,

	// Other types to be exported
	Progress,
	Headers,
	RequestFunction,
	Agents,
	Method,
	PromiseCookieJar,

	// Types that will not be exported
	RequestEvents
} from '../core';
import PromisableRequest from './core';

export type ResponseType = 'json' | 'buffer' | 'text';

export interface Response<T = unknown> extends RequestResponse<T> {
	request: PromisableRequest;
}

export interface RetryObject {
	attemptCount: number;
	retryOptions: RequiredRetryOptions;
	error: TimeoutError | RequestError;
	computedValue: number;
}

export type RetryFunction = (retryObject: RetryObject) => number | Promise<number>;

export interface RequiredRetryOptions {
	limit: number;
	methods: Method[];
	statusCodes: number[];
	errorCodes: string[];
	calculateDelay: RetryFunction;
	maxRetryAfter?: number;
}

export type BeforeRetryHook = (options: NormalizedOptions, error?: RequestError, retryCount?: number) => void | Promise<void>;
export type AfterResponseHook = (response: Response, retryWithMergedOptions: (options: Options) => CancelableRequest<Response>) => Response | CancelableRequest<Response> | Promise<Response | CancelableRequest<Response>>;

export interface Hooks extends RequestHooks {
	beforeRetry?: BeforeRetryHook[];
	afterResponse?: AfterResponseHook[];
}

export interface PaginationOptions<T, R> {
	pagination?: {
		/**
		A function that transform [`Response`](#response) into an array of items.
		This is where you should do the parsing.

		@default response => JSON.parse(response.body)
		*/
		transform?: (response: Response<R>) => Promise<T[]> | T[];

		/**
		Checks whether the item should be emitted or not.

		@default (item, allItems, currentItems) => true
		*/
		filter?: (item: T, allItems: T[], currentItems: T[]) => boolean;

		/**
		The function takes three arguments:
		- `response` - The current response object.
		- `allItems` - An array of the emitted items.
		- `currentItems` - Items from the current response.

		It should return an object representing Got options pointing to the next page.
		The options are merged automatically with the previous request, therefore the options returned `pagination.paginate(...)` must reflect changes only.
		If there are no more pages, `false` should be returned.

		@example
		```
		const got = require('got');

		(async () => {
			const limit = 10;

			const items = got.paginate('https://example.com/items', {
				searchParams: {
					limit,
					offset: 0
				},
				pagination: {
					paginate: (response, allItems, currentItems) => {
						const previousSearchParams = response.request.options.searchParams;
						const previousOffset = previousSearchParams.get('offset');

						if (currentItems.length < limit) {
							return false;
						}

						return {
							searchParams: {
								...previousSearchParams,
								offset: Number(previousOffset) + limit,
							}
						};
					}
				}
			});

			console.log('Items from all pages:', items);
		})();
		```
		*/
		paginate?: (response: Response<R>, allItems: T[], currentItems: T[]) => Options | false;

		/**
		Checks whether the pagination should continue.

		For example, if you need to stop **before** emitting an entry with some flag, you should use `(item, allItems, currentItems) => !item.flag`.
		If you want to stop **after** emitting the entry, you should use `(item, allItems, currentItems) => allItems.some(entry => entry.flag)` instead.

		@default (item, allItems, currentItems) => true
		*/
		shouldContinue?: (item: T, allItems: T[], currentItems: T[]) => boolean;

		/**
		The maximum amount of items that should be emitted.

		@default Infinity
		*/
		countLimit?: number;

		/**
		The maximum amount of request that should be triggered.
		Retries on failure are not counted towards this limit.

		For example, it can be helpful during development to avoid an infinite number of requests.

		@default 10000
		*/
		requestLimit?: number;

		/**
		Defines how the parameter `allItems` in pagination.paginate, pagination.filter and pagination.shouldContinue is managed.
		When set to `false`, the parameter `allItems` is always an empty array.

		This option can be helpful to save on memory usage when working with a large dataset.
		*/
		stackAllItems?: boolean;
	};
}

export interface Options extends RequestOptions, PaginationOptions<unknown, unknown> {
	hooks?: Hooks;
	responseType?: ResponseType;
	resolveBodyOnly?: boolean;
	retry?: Partial<RequiredRetryOptions> | number;
	isStream?: boolean;
	encoding?: BufferEncoding;
}

export interface NormalizedOptions extends RequestNormalizedOptions {
	hooks: Required<Hooks>;
	responseType: ResponseType;
	resolveBodyOnly: boolean;
	retry: RequiredRetryOptions;
	isStream: boolean;
	encoding?: BufferEncoding;
	pagination?: Required<PaginationOptions<unknown, unknown>['pagination']>;
}

export interface Defaults extends RequestDefaults {
	hooks: Required<Hooks>;
	responseType: ResponseType;
	resolveBodyOnly: boolean;
	retry: RequiredRetryOptions;
	isStream: boolean;
	pagination?: Required<PaginationOptions<unknown, unknown>['pagination']>;
}

export class ParseError extends RequestError {
	declare readonly response: Response;

	constructor(error: Error, response: Response) {
		const {options} = response.request;

		super(`${error.message} in "${options.url.toString()}"`, error, response.request);
		this.name = 'ParseError';

		Object.defineProperty(this, 'response', {
			enumerable: false,
			value: response
		});
	}
}

export interface CancelableRequest<T extends Response | Response['body'] = Response['body']> extends PCancelable<T>, RequestEvents<CancelableRequest<T>> {
	json<ReturnType>(): CancelableRequest<ReturnType>;
	buffer(): CancelableRequest<Buffer>;
	text(): CancelableRequest<string>;
}

export type HookEvent = RequestHookEvent | 'beforeRetry' | 'afterResponse';

export {
	RequestError,
	MaxRedirectsError,
	CacheError,
	UploadError,
	TimeoutError,
	HTTPError,
	ReadError,
	UnsupportedProtocolError,
	CancelError
};

export {
	InitHook,
	BeforeRequestHook,
	BeforeRedirectHook,
	BeforeErrorHook
};

export {
	Progress,
	Headers,
	RequestFunction,
	Agents,
	Method,
	PromiseCookieJar
};
