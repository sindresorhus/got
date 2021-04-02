import {Response} from './core/response';
import create from './create';
import {InstanceDefaults} from './types';
import parseLinkHeader from './utils/parse-link-header';

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
		methodRewriting: false,
		ignoreInvalidCookies: false,
		context: {},
		// TODO: Set this to `true` for Got 13.
		http2: false,
		allowGetBody: false,
		httpsOptions: {},
		request: undefined,
		agent: {},
		body: undefined,
		json: undefined,
		form: undefined,
		url: undefined,
		cookieJar: undefined,
		searchParameters: undefined,
		dnsLookup: undefined,
		username: '',
		password: '',
		dnsLookupIpVersion: undefined,
		localAddress: undefined,
		createConnection: undefined,
		encoding: undefined,
		setHost: true,
		maxHeaderSize: undefined,
		pagination: {
			transform: (response: Response) => {
				if (response.request.options.responseType === 'json') {
					return response.body;
				}

				return JSON.parse(response.body as string);
			},
			paginate: ({response}) => {
				if (typeof response.headers.link !== 'string') {
					return false;
				}

				const parsed = parseLinkHeader(response.headers.link);
				const next = parsed.find(entry => entry.parameters.rel === 'next' || entry.parameters.rel === '"next"');

				if (next) {
					return {url: next.reference};
				}

				return false;
			},
			filter: () => true,
			shouldContinue: () => true,
			countLimit: Number.POSITIVE_INFINITY,
			backoff: 0,
			requestLimit: 10000,
			stackAllItems: false
		},
		parseJson: (text: string) => JSON.parse(text),
		stringifyJson: (object: unknown) => JSON.stringify(object),
		cacheOptions: {}
	},
	handlers: [],
	mutableDefaults: false
};

const got = create(defaults);

export default got;
export {got};

export {default as Options} from './core/options';
export * from './core/options';
export * from './core/response';
export * from './core/index';
export * from './core/errors';
export {default as calculateRetryDelay} from './core/calculate-retry-delay';
export * from './core/calculate-retry-delay';
export * from './as-promise/types';
export * from './types';
export {default as create} from './create';
export {default as parseLinkHeader} from './utils/parse-link-header';
