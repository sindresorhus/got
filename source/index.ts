import {URL} from 'url';
import create, {defaultHandler} from './create';
import {Defaults, Response, GotOptions} from './types';

const defaults: Defaults = {
	options: {
		method: 'GET',
		retry: {
			limit: 2,
			methods: [
				'GET',
				'PUT',
				'HEAD',
				'DELETE',
				'OPTIONS',
				'TRACE'
			],
			statusCodes: [
				408,
				413,
				429,
				500,
				502,
				503,
				504,
				521,
				522,
				524
			],
			errorCodes: [
				'ETIMEDOUT',
				'ECONNRESET',
				'EADDRINUSE',
				'ECONNREFUSED',
				'EPIPE',
				'ENOTFOUND',
				'ENETUNREACH',
				'EAI_AGAIN'
			],
			maxRetryAfter: undefined,
			calculateDelay: ({computedValue}) => computedValue
		},
		timeout: {},
		headers: {
			'user-agent': 'got (https://github.com/sindresorhus/got)'
		},
		hooks: {
			init: [],
			beforeRequest: [],
			beforeRedirect: [],
			beforeRetry: [],
			beforeError: [],
			afterResponse: []
		},
		decompress: true,
		throwHttpErrors: true,
		followRedirect: true,
		isStream: false,
		cache: false,
		dnsCache: false,
		useElectronNet: false,
		responseType: 'text',
		resolveBodyOnly: false,
		maxRedirects: 10,
		prefixUrl: '',
		methodRewriting: true,
		allowGetBody: false,
		ignoreInvalidCookies: false,
		context: {},
		_pagination: {
			transform: (response: Response) => {
				return JSON.parse(response.body as string);
			},
			paginate: response => {
				if (!Reflect.has(response.headers, 'link')) {
					return false;
				}

				const items = (response.headers.link as string).split(',');

				let next: string | undefined;
				for (const item of items) {
					const parsed = item.split(';');

					if (parsed[1].includes('next')) {
						next = parsed[0].trimStart().trim();
						next = next.slice(1, -1);
						break;
					}
				}

				if (next) {
					const options: GotOptions = {
						url: new URL(next)
					};

					return options;
				}

				return false;
			},
			filter: () => true,
			shouldContinue: () => true,
			countLimit: Infinity
		}
	},
	handlers: [defaultHandler],
	mutableDefaults: false
};

const got = create(defaults);

export default got;

// For CommonJS default export support
module.exports = got;
module.exports.default = got;

// Export types
export * from './types';

export {
	Got,
	GotStream,
	ReturnStream,
	GotRequestMethod,
	GotReturn
} from './create';

export {
	ProxyStream as ResponseStream
} from './as-stream';

export {
	GotError,
	CacheError,
	RequestError,
	ReadError,
	ParseError,
	HTTPError,
	MaxRedirectsError,
	UnsupportedProtocolError,
	TimeoutError,
	CancelError
} from './errors';

export {
	InitHook,
	BeforeRequestHook,
	BeforeRedirectHook,
	BeforeRetryHook,
	BeforeErrorHook,
	AfterResponseHook,
	HookType,
	Hooks,
	HookEvent
} from './known-hook-events';
