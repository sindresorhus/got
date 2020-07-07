import PCancelable = require('p-cancelable');
import {CancelError} from 'p-cancelable';
import {
	NormalizedOptions,
	Options,
	Response,
	Method,
	TimeoutError,
	RequestError,
	RequestEvents
} from '../core';

export type ResponseType = 'json' | 'buffer' | 'text';

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

export interface PaginationOptions<T, R> {
	pagination?: {
		transform?: (response: Response<R>) => Promise<T[]> | T[];
		filter?: (item: T, allItems: T[], currentItems: T[]) => boolean;
		paginate?: (response: Response<R>, allItems: T[], currentItems: T[]) => Options | false;
		shouldContinue?: (item: T, allItems: T[], currentItems: T[]) => boolean;
		countLimit?: number;
		backoff?: number;
		requestLimit?: number;
		stackAllItems?: boolean;
	};
}

export type BeforeRetryHook = (options: NormalizedOptions, error?: RequestError, retryCount?: number) => void | Promise<void>;
export type AfterResponseHook = (response: Response, retryWithMergedOptions: (options: Options) => CancelableRequest<Response>) => Response | CancelableRequest<Response> | Promise<Response | CancelableRequest<Response>>;

// These should be merged into Options in core/index.ts
export namespace PromiseOnly {
	export interface Hooks {
		beforeRetry?: BeforeRetryHook[];
		afterResponse?: AfterResponseHook[];
	}

	export interface Options extends PaginationOptions<unknown, unknown> {
		responseType?: ResponseType;
		resolveBodyOnly?: boolean;
		retry?: Partial<RequiredRetryOptions> | number;
		isStream?: boolean;
		encoding?: BufferEncoding;
	}

	export interface NormalizedOptions {
		responseType: ResponseType;
		resolveBodyOnly: boolean;
		retry: RequiredRetryOptions;
		isStream: boolean;
		encoding?: BufferEncoding;
		pagination?: Required<PaginationOptions<unknown, unknown>['pagination']>;
	}

	export interface Defaults {
		responseType: ResponseType;
		resolveBodyOnly: boolean;
		retry: RequiredRetryOptions;
		isStream: boolean;
		pagination?: Required<PaginationOptions<unknown, unknown>['pagination']>;
	}

	export type HookEvent = 'beforeRetry' | 'afterResponse';
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
	json: <ReturnType>() => CancelableRequest<ReturnType>;
	buffer: () => CancelableRequest<Buffer>;
	text: () => CancelableRequest<string>;
}

export {CancelError};
export * from '../core';
