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

	// Types that will not be exported
	Method,
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

export type RetryFunction = (retryObject: RetryObject) => number;

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

export interface PaginationOptions<T> {
	pagination?: {
		transform?: (response: Response) => Promise<T[]> | T[];
		filter?: (item: T, allItems: T[], currentItems: T[]) => boolean;
		paginate?: (response: Response, allItems: T[], currentItems: T[]) => Options | false;
		shouldContinue?: (item: T, allItems: T[], currentItems: T[]) => boolean;
		countLimit?: number;
	};
}

export interface Options extends RequestOptions, PaginationOptions<unknown> {
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
	pagination?: Required<PaginationOptions<unknown>['pagination']>;
}

export interface Defaults extends RequestDefaults {
	hooks: Required<Hooks>;
	responseType: ResponseType;
	resolveBodyOnly: boolean;
	retry: RequiredRetryOptions;
	isStream: boolean;
	pagination?: Required<PaginationOptions<unknown>['pagination']>;
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
	RequestFunction
};
