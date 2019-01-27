import {RequestOptions} from 'https';
import {IncomingMessage} from 'http';

// TODO: This may be a bit overkill. It was done for different reasons:
//       - Expose hook types individually for consumers of the API to easily
//         type - check their own code that may rely on those specific hooks.
//
//        There are some cons about this, though:
//
//        - Doesn't properly provide the function signature which ends up hiding type information such as the arguments and return types that could be helpful.
export type BeforeErrorHook = (error: Error) => void;
export type InitHook = (options: RequestOptions) => void;
export type BeforeRequestHook = (options: RequestOptions) => void | Promise<void>
export type BeforeRedirectHook = (options: RequestOptions) => void | Promise<void>
export type BeforeRetryHook = (options: RequestOptions) => void | Promise<void>
// TODO: Update the return type for the retry handler to be an extended PCancelable promise type with extra properties.
export type AfterResponseHook = (response: IncomingMessage, retryWithMergedOptions: (options: unknown) => any) => void | Promise<void>

export type HookType = BeforeErrorHook | InitHook | BeforeRequestHook | BeforeRedirectHook | BeforeRetryHook | AfterResponseHook;

export interface Hooks {
	beforeError: BeforeErrorHook[];

	/**
	 * Called with plain request options, right before their normalization. This is especially useful in conjunction with got.extend() and got.create() when the input needs custom handling.
	 *
	 * @default []
	 */
	init: InitHook[];
	beforeRequest: BeforeRequestHook[];
	beforeRedirect: BeforeRedirectHook[];
	beforeRetry: BeforeRetryHook[];
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
