import https = require('https');
import {format} from 'url';
import CacheableLookup from 'cacheable-lookup';
import is from '@sindresorhus/is';
import lowercaseKeys = require('lowercase-keys');
import Keyv = require('keyv');
import urlToOptions, {URLOptions} from './utils/url-to-options';
import validateSearchParams from './utils/validate-search-params';
import supportsBrotli from './utils/supports-brotli';
import merge, {mergeOptions} from './merge';
import knownHookEvents from './known-hook-events';
import {
	Options,
	NormalizedOptions,
	NormalizedRetryOptions,
	RetryOptions,
	Method,
	Delays,
	URLArgument,
	URLOrOptions,
	NormalizedDefaults
} from './utils/types';

let hasShownDeprecation = false;

// `preNormalize` handles static options (e.g. headers).
// For example, when you create a custom instance and make a request
// with no static changes, they won't be normalized again.
//
// `normalize` operates on dynamic options - they cannot be saved.
// For example, `body` is every time different per request.
// When it's done normalizing the new options, it performs merge()
// on the prenormalized options and the normalized ones.

export const preNormalizeArguments = (options: Options, defaults?: NormalizedOptions): NormalizedOptions => {
	if (is.nullOrUndefined(options.headers)) {
		options.headers = {};
	} else {
		options.headers = lowercaseKeys(options.headers);
	}

	if (options.prefixUrl) {
		options.prefixUrl = options.prefixUrl.toString();

		if (!options.prefixUrl.endsWith('/')) {
			options.prefixUrl += '/';
		}
	}

	if (is.nullOrUndefined(options.hooks)) {
		options.hooks = {};
	} else if (is.object(options.hooks)) {
		for (const event in options.hooks) {
			if (!is.array(options.hooks[event])) {
				throw new TypeError(`Parameter \`${event}\` must be an Array, not ${is(options.hooks[event])}`);
			}
		}
	} else {
		throw new TypeError(`Parameter \`hooks\` must be an Object, not ${is(options.hooks)}`);
	}

	for (const event of knownHookEvents) {
		if (is.nullOrUndefined(options.hooks[event])) {
			if (defaults && defaults.hooks) {
				if (event in defaults.hooks) {
					// @ts-ignore
					options.hooks[event] = defaults.hooks[event]!.slice();
				}
			} else {
				options.hooks[event] = [];
			}
		}
	}

	if (is.number(options.timeout)) {
		options.timeout = {request: options.timeout};
	}

	const {retry} = options;
	options.retry = {
		calculateDelay: retryObject => retryObject.computedValue,
		methods: new Set(),
		statusCodes: new Set(),
		errorCodes: new Set(),
		maxRetryAfter: undefined
	};

	if (is.nonEmptyObject(defaults) && retry !== false) {
		options.retry = {...(defaults.retry as unknown as RetryOptions)};
	}

	if (retry !== false) {
		if (is.number(retry)) {
			options.retry.limit = retry;
		} else {
			// @ts-ignore
			const retryOption: NormalizedRetryOptions = {...options.retry, ...retry};
			options.retry = retryOption;
		}
	}

	if (!options.retry.maxRetryAfter && options.gotTimeout) {
		options.retry.maxRetryAfter = Math.min(...[(options.gotTimeout as Delays).request, (options.gotTimeout as Delays).connect].filter(n => !is.nullOrUndefined(n)));
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

export const normalizeArguments = (url: URLOrOptions, options: Options, defaults?: NormalizedDefaults): NormalizedOptions => {
	let urlArgument: URLArgument;
	if (is.plainObject(url)) {
		options = {...url as Options, ...options};
		urlArgument = options.url || {};
		delete options.url;
	} else {
		urlArgument = url;
	}

	if (defaults) {
		options = mergeOptions(defaults.options, options ? preNormalizeArguments(options, defaults.options) : {});
	} else {
		options = merge({}, preNormalizeArguments(options));
	}

	if (!is.string(urlArgument) && !is.object(urlArgument)) {
		throw new TypeError(`Parameter \`url\` must be a string or an Object, not ${is(urlArgument)}`);
	}

	let urlObj: https.RequestOptions | URLOptions;
	if (is.string(urlArgument)) {
		if (options.prefixUrl && urlArgument.startsWith('/')) {
			throw new Error('`url` must not begin with a slash when using `prefixUrl`');
		}

		if (options.prefixUrl) {
			urlArgument = options.prefixUrl.toString() + urlArgument;
		}

		urlArgument = urlArgument.replace(/^unix:/, 'http://$&');

		urlObj = urlToOptions(new URL(urlArgument));
	} else if (is.urlInstance(urlArgument)) {
		urlObj = urlToOptions(urlArgument);
	} else if (options.prefixUrl) {
		urlObj = {
			// @ts-ignore
			...urlToOptions(new URL(options.prefixUrl)),
			...urlArgument
		};
	} else {
		urlObj = urlArgument;
	}

	// Override both null/undefined with default protocol
	options = mergeOptions({path: ''}, urlObj, {protocol: urlObj.protocol || 'https:'}, options);

	for (const hook of options.hooks.init) {
		if (is.asyncFunction(hook)) {
			throw new TypeError('The `init` hook must be a synchronous function');
		}

		// @ts-ignore TS is dumb.
		hook(options);
	}

	const {prefixUrl} = options;
	Object.defineProperty(options, 'prefixUrl', {
		set: () => {
			throw new Error('Failed to set prefixUrl. Options are normalized already.');
		},
		get: () => prefixUrl
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

	if (is.nonEmptyString(searchParams) || is.nonEmptyObject(searchParams) || (searchParams && searchParams instanceof URLSearchParams)) {
		if (!is.string(searchParams)) {
			if (!(searchParams instanceof URLSearchParams)) {
				validateSearchParams(searchParams);
			}

			searchParams = (new URLSearchParams(searchParams as Record<string, string>)).toString();
		}

		options.path = `${options.path.split('?')[0]}?${searchParams}`;
	}

	if (options.hostname === 'unix') {
		const matches = /(?<socketPath>.+?):(?<path>.+)/.exec(options.path);

		if (matches) {
			const {socketPath, path} = matches.groups;
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

	return options as NormalizedOptions;
};

export const reNormalizeArguments = (options: Options): NormalizedOptions => normalizeArguments(format(options as unknown as URL | URLOptions), options);
