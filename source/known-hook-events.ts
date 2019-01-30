import {IncomingMessage} from 'http';
import {Options, CancelableRequest} from './utils/types';
import {HTTPError} from './errors';

/**
 * Called with plain request options, right before their normalization. This is especially useful in conjunction with got.extend() and got.create() when the input needs custom handling.
 *
 * **Note:** This hook must be synchronous.
 *
 * @see [Request migration guide](https://github.com/sindresorhus/got/blob/master/migration-guides.md#breaking-changes) for an example.
 */
export type InitHook = (options: Options) => void;

/**
 * Called with normalized [request options](https://github.com/sindresorhus/got#options). Got will make no further changes to the request before it is sent (except the body serialization). This is especially useful in conjunction with [`got.extend()`](https://github.com/sindresorhus/got#instances) and [`got.create()`](https://github.com/sindresorhus/got/blob/master/advanced-creation.md) when you want to create an API client that, for example, uses HMAC-signing.
 *
 * @see [AWS section](https://github.com/sindresorhus/got#aws) for an example.
 */
export type BeforeRequestHook = (options: Options) => void | Promise<void>;

/**
 * Called with normalized [request options](https://github.com/sindresorhus/got#options). Got will make no further changes to the request. This is especially useful when you want to avoid dead sites.
 */
export type BeforeRedirectHook = (options: Options) => void | Promise<void>;

/**
 * Called with normalized [request options](https://github.com/sindresorhus/got#options), the error and the retry count. Got will make no further changes to the request. This is especially useful when some extra work is required before the next try.
 */
export type BeforeRetryHook = (options: Options, error: HTTPError, retryCount: number) => void | Promise<void>;

// TODO: The `Error` type should conform to any possible extended error type that can be thrown. See https://github.com/sindresorhus/got#hooksbeforeerror
/**
 * Called with an `Error` instance. The error is passed to the hook right before it's thrown. This is especially useful when you want to have more detailed errors.
 *
 * **Note:** Errors thrown while normalizing input options are thrown directly and not part of this hook.
 */
export type BeforeErrorHook = (error: Error) => Error | Promise<Error>;

/**
 * Called with [response object](https://github.com/sindresorhus/got#response) and a retry function.
 *
 * Each function should return the response. This is especially useful when you want to refresh an access token.
 */
export type AfterResponseHook = (response: IncomingMessage, retryWithMergedOptions: (options: Options) => CancelableRequest<IncomingMessage>) => IncomingMessage | CancelableRequest<IncomingMessage>;

export type HookType = BeforeErrorHook | InitHook | BeforeRequestHook | BeforeRedirectHook | BeforeRetryHook | AfterResponseHook;

/**
 * Hooks allow modifications during the request lifecycle. Hook functions may be async and are run serially.
 */
export interface Hooks {
	/**
	 * Called with plain request options, right before their normalization. This is especially useful in conjunction with got.extend() and got.create() when the input needs custom handling.
	 *
	 * **Note:** This hook must be synchronous.
	 *
	 * @see [Request migration guide](https://github.com/sindresorhus/got/blob/master/migration-guides.md#breaking-changes) for an example.
	 * @default []
	 */
	init: InitHook[];

	/**
	 * Called with normalized [request options](https://github.com/sindresorhus/got#options). Got will make no further changes to the request before it is sent (except the body serialization). This is especially useful in conjunction with [`got.extend()`](https://github.com/sindresorhus/got#instances) and [`got.create()`](https://github.com/sindresorhus/got/blob/master/advanced-creation.md) when you want to create an API client that, for example, uses HMAC-signing.
	 *
	 * @see [AWS section](https://github.com/sindresorhus/got#aws) for an example.
	 * @default []
	 */
	beforeRequest: BeforeRequestHook[];

	/**
	 * Called with normalized [request options](https://github.com/sindresorhus/got#options). Got will make no further changes to the request. This is especially useful when you want to avoid dead sites.
	 *
	 * @default []
	 */
	beforeRedirect: BeforeRedirectHook[];

	/**
	 * Called with normalized [request options](https://github.com/sindresorhus/got#options), the error and the retry count. Got will make no further changes to the request. This is especially useful when some extra work is required before the next try.
	 *
	 * @default []
	 */
	beforeRetry: BeforeRetryHook[];

	/**
	 * Called with an `Error` instance. The error is passed to the hook right before it's thrown. This is especially useful when you want to have more detailed errors.
	 *
	 * **Note:** Errors thrown while normalizing input options are thrown directly and not part of this hook.
	 *
	 * @default []
	 */
	beforeError: BeforeErrorHook[];

	/**
	 * Called with [response object](https://github.com/sindresorhus/got#response) and a retry function.
	 *
	 * Each function should return the response. This is especially useful when you want to refresh an access token.
	 *
	 * @default []
	 */
	afterResponse: AfterResponseHook[];
}

export type HookEvent = keyof Hooks;

const knownHookEvents: HookEvent[] = [
	'beforeError',
	'init',
	'beforeRequest',
	'beforeRedirect',
	'beforeRetry',
	'afterResponse'
];

export default knownHookEvents;
