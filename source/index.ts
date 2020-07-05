import {URL} from 'url';
import {Response, Options} from './as-promise';
import create, {defaultHandler, InstanceDefaults} from './create';

const defaults: InstanceDefaults = {
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
		cache: undefined,
		dnsCache: undefined,
		decompress: true,
		throwHttpErrors: true,
		followRedirect: true,
		isStream: false,
		responseType: 'text',
		resolveBodyOnly: false,
		maxRedirects: 10,
		prefixUrl: '',
		methodRewriting: true,
		ignoreInvalidCookies: false,
		context: {},
		// TODO: Set this to `true` when Got 12 gets released
		http2: false,
		allowGetBody: false,
		https: undefined,
		pagination: {
			transform: (response: Response) => {
				if (response.request.options.responseType === 'json') {
					return response.body;
				}

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
					const options: Options = {
						url: new URL(next)
					};

					return options;
				}

				return false;
			},
			filter: () => true,
			shouldContinue: () => true,
			countLimit: Infinity,
			requestLimit: 10000,
			stackAllItems: true
		},
		parseJson: (text: string) => JSON.parse(text),
		stringifyJson: (object: unknown) => JSON.stringify(object)
	},
	handlers: [defaultHandler],
	mutableDefaults: false
};

const got = create(defaults);

export default got;

// For CommonJS default export support
module.exports = got;
module.exports.default = got;
module.exports.__esModule = true; // Workaround for TS issue: https://github.com/sindresorhus/got/pull/1267

export * from './create';
export * from './as-promise';
