import https = require('https');
import {format, URL, URLSearchParams} from 'url';
import CacheableLookup from 'cacheable-lookup';
import is from '@sindresorhus/is';
import lowercaseKeys = require('lowercase-keys');
import Keyv = require('keyv');
import urlToOptions, {URLOptions} from './utils/url-to-options';
import validateSearchParams from './utils/validate-search-params';
import supportsBrotli from './utils/supports-brotli';
import merge from './merge';
import knownHookEvents from './known-hook-events';
import {
	Options,
	Defaults,
	NormalizedOptions,
	NormalizedRetryOptions,
	RetryOption,
	Method,
	Delays,
	ErrorCode,
	StatusCode,
	URLArgument,
	URLOrOptions
} from './utils/types';
import {HTTPError, ParseError, MaxRedirectsError, GotError} from './errors';

const retryAfterStatusCodes: ReadonlySet<StatusCode> = new Set([413, 429, 503]);

let hasShownDeprecation = false;

// `preNormalize` handles static options (e.g. headers).
// For example, when you create a custom instance and make a request
// with no static changes, they won't be normalized again.
//
// `normalize` operates on dynamic options - they cannot be saved.
// For example, `body` is every time different per request.
// When it's done normalizing the new options, it performs merge()
// on the prenormalized options and the normalized ones.

export const preNormalizeArguments = (options: Options, defaults?: Options): NormalizedOptions => {
	if (is.nullOrUndefined(options.headers)) {
		options.headers = {};
	} else {
		options.headers = lowercaseKeys(options.headers);
	}

	if (options.baseUrl && !options.baseUrl.toString().endsWith('/')) {
		options.baseUrl += '/';
	}

	if (is.nullOrUndefined(options.hooks)) {
		options.hooks = {};
	} else if (!is.object(options.hooks)) {
		throw new TypeError(`Parameter \`hooks\` must be an object, not ${is(options.hooks)}`);
	}

	for (const event of knownHookEvents) {
		if (is.nullOrUndefined(options.hooks[event])) {
			if (defaults && defaults.hooks) {
				if (event in defaults.hooks) {
					options.hooks[event] = defaults.hooks[event]!.slice();
				}
			} else {
				options.hooks[event] = [];
			}
		}
	}

	if (is.number(options.timeout)) {
		options.gotTimeout = {request: options.timeout};
	} else if (is.object(options.timeout)) {
		options.gotTimeout = options.timeout;
	}

	delete options.timeout;

	const {retry} = options;
	options.retry = {
		retries: () => 0,
		methods: new Set(),
		statusCodes: new Set(),
		errorCodes: new Set(),
		maxRetryAfter: undefined
	};

	if (is.nonEmptyObject(defaults) && retry !== false) {
		options.retry = {...(defaults.retry as RetryOption)};
	}

	if (retry !== false) {
		if (is.number(retry)) {
			options.retry.retries = retry;
		} else {
			// eslint-disable-next-line @typescript-eslint/no-object-literal-type-assertion
			options.retry = {...options.retry, ...retry} as NormalizedRetryOptions;
		}
	}

	if (!options.retry.maxRetryAfter && options.gotTimeout) {
		options.retry.maxRetryAfter = Math.min(...[(options.gotTimeout as Delays).request!, (options.gotTimeout as Delays).connect!].filter(n => !is.nullOrUndefined(n)));
	}

	if (is.array(options.retry.methods)) {
		options.retry.methods = new Set(options.retry.methods.map(method => method.toUpperCase())) as ReadonlySet<Method>;
	}

	if (is.array(options.retry.statusCodes)) {
		options.retry.statusCodes = new Set(options.retry.statusCodes);
	}

	if (is.array(options.retry.errorCodes)) {
		options.retry.errorCodes = new Set(options.retry.errorCodes);
	}

	if (options.dnsCache) {
		const cacheableLookup = new CacheableLookup({cacheAdapter: options.dnsCache as Keyv | undefined});
		(options as NormalizedOptions).lookup = cacheableLookup.lookup;
		delete options.dnsCache;
	}

	return options as NormalizedOptions;
};

export const normalizeArguments = (url: URLOrOptions, options: NormalizedOptions, defaults?: Defaults): NormalizedOptions => {
	let urlArgument: URLArgument;
	if (is.plainObject(url)) {
		options = {...url, ...options};
		urlArgument = options.url || '';
		delete options.url;
	} else {
		urlArgument = url;
	}

	if (defaults) {
		options = merge<NormalizedOptions, Options>({} as NormalizedOptions, defaults.options!, options ? preNormalizeArguments(options, defaults.options) : {});
	} else {
		options = merge({}, preNormalizeArguments(options));
	}

	if (!is.string(urlArgument) && !is.object(urlArgument)) {
		throw new TypeError(`Parameter \`url\` must be a string or object, not ${is(urlArgument)}`);
	}

	let urlObj: https.RequestOptions | URLOptions;
	if (is.string(urlArgument)) {
		if (options.baseUrl) {
			if (urlArgument.startsWith('/')) {
				urlArgument = urlArgument.slice(1);
			}
		} else {
			urlArgument = urlArgument.replace(/^unix:/, 'http://$&');
		}

		urlObj = urlArgument || options.baseUrl ? urlToOptions(new URL(urlArgument, options.baseUrl)) : {};
	} else if (is.urlInstance(urlArgument)) {
		urlObj = urlToOptions(urlArgument);
	} else {
		urlObj = urlArgument;
	}

	// Override both null/undefined with default protocol
	options = merge<NormalizedOptions, Partial<URL | URLOptions | NormalizedOptions | Options>>({path: ''} as NormalizedOptions, urlObj, {protocol: urlObj.protocol || 'https:'}, options);

	for (const hook of options.hooks.init) {
		const isCalled = hook(options);

		if (is.promise(isCalled)) {
			throw new TypeError('The `init` hook must be a synchronous function');
		}
	}

	const {baseUrl} = options;
	Object.defineProperty(options, 'baseUrl', {
		set: () => {
			throw new Error('Failed to set baseUrl. Options are normalized already.');
		},
		get: () => baseUrl
	});

	let {searchParams} = options;
	delete options.searchParams;

	// TODO: Remove this before Got v11
	if (options.query) {
		if (!hasShownDeprecation) {
			console.warn('`options.query` is deprecated. We support it solely for compatibility - it will be removed in Got 11. Use `options.searchParams` instead.');
			hasShownDeprecation = true;
		}

		searchParams = options.query;
		delete options.query;
	}

	if (is.nonEmptyString(searchParams) || is.nonEmptyObject(searchParams) || (searchParams && searchParams! instanceof URLSearchParams)) {
		if (!is.string(searchParams)) {
			if (!(searchParams instanceof URLSearchParams)) {
				validateSearchParams(searchParams);
			}

			searchParams = (new URLSearchParams(searchParams as Record<string, string>)).toString();
		}

		options.path = `${options.path.split('?')[0]}?${searchParams}`;
	}

	if (options.hostname === 'unix') {
		const matches = /(.+?):(.+)/.exec(options.path);

		if (matches) {
			const [, socketPath, path] = matches;
			options = {
				...options,
				socketPath,
				path,
				host: ''
			};
		}
	}

	const {headers} = options;
	for (const [key, value] of Object.entries(headers)) {
		if (is.nullOrUndefined(value)) {
			delete headers[key];
		}
	}

	if (options.decompress && is.undefined(headers['accept-encoding'])) {
		headers['accept-encoding'] = supportsBrotli ? 'gzip, deflate, br' : 'gzip, deflate';
	}

	if (options.method) {
		options.method = options.method.toUpperCase() as Method;
	}

	if (!is.function_(options.retry.retries)) {
		const {retries} = options.retry;

		options.retry.retries = (iteration, error) => {
			if (iteration > retries) {
				return 0;
			}

			const hasMethod = options.retry.methods.has((error as GotError).options.method as Method);
			const hasErrorCode = Reflect.has(error, 'code') && options.retry.errorCodes.has((error as GotError).code as ErrorCode);
			const hasStatusCode = Reflect.has(error, 'response') && options.retry.statusCodes.has((error as HTTPError | ParseError | MaxRedirectsError).response.statusCode as StatusCode);
			if (!hasMethod || (!hasErrorCode && !hasStatusCode)) {
				return 0;
			}

			const {response} = error as HTTPError | ParseError | MaxRedirectsError;
			if (response && Reflect.has(response.headers, 'retry-after') && retryAfterStatusCodes.has(response.statusCode as StatusCode)) {
				let after = Number(response.headers['retry-after']);
				if (is.nan(after)) {
					after = Date.parse(response.headers['retry-after']!) - Date.now();
				} else {
					after *= 1000;
				}

				if (after > options.retry.maxRetryAfter) {
					return 0;
				}

				return after;
			}

			if (response && response.statusCode === 413) {
				return 0;
			}

			const noise = Math.random() * 100;
			return ((2 ** (iteration - 1)) * 1000) + noise;
		};
	}

	return options;
};

export const reNormalizeArguments = (options: NormalizedOptions): NormalizedOptions => normalizeArguments(format(options as unknown as URL | URLOptions), options);
