import PCancelable = require('p-cancelable');
import Request, {
	Options,
	Response,
	RequestError,
	RequestEvents
} from '../core';

export type ResponseType = 'json' | 'buffer' | 'text';

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
		Milliseconds to wait before the next request is triggered.

		@default 0
		*/
		backoff?: number;
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

export type AfterResponseHook = (response: Response, retryWithMergedOptions: (options: Options) => CancelableRequest<Response>) => Response | CancelableRequest<Response> | Promise<Response | CancelableRequest<Response>>;

// These should be merged into Options in core/index.ts
export namespace PromiseOnly {
	export interface Hooks {
		afterResponse?: AfterResponseHook[];
	}

	export interface Options extends PaginationOptions<unknown, unknown> {
		responseType?: ResponseType;
		resolveBodyOnly?: boolean;
		isStream?: boolean;
		encoding?: BufferEncoding;
	}

	export interface NormalizedOptions {
		responseType: ResponseType;
		resolveBodyOnly: boolean;
		isStream: boolean;
		encoding?: BufferEncoding;
		pagination?: Required<PaginationOptions<unknown, unknown>['pagination']>;
	}

	export interface Defaults {
		responseType: ResponseType;
		resolveBodyOnly: boolean;
		isStream: boolean;
		pagination?: Required<PaginationOptions<unknown, unknown>['pagination']>;
	}

	export type HookEvent = 'afterResponse';
}

export class ParseError extends RequestError {
	declare readonly response: Response;

	constructor(error: Error, response: Response) {
		const {options} = response.request;

		super(`${error.message} in "${options.url.toString()}"`, error, response.request);
		this.name = 'ParseError';
	}
}

export class CancelError extends RequestError {
	declare readonly response: Response;

	constructor(request: Request) {
		super('Promise was canceled', {}, request);
		this.name = 'CancelError';
	}

	get isCanceled() {
		return true;
	}
}

export interface CancelableRequest<T extends Response | Response['body'] = Response['body']> extends PCancelable<T>, RequestEvents<CancelableRequest<T>> {
	json: <ReturnType>() => CancelableRequest<ReturnType>;
	buffer: () => CancelableRequest<Buffer>;
	text: () => CancelableRequest<string>;
}

export * from '../core';
