import CacheableLookup from 'cacheable-lookup';
import is from '@sindresorhus/is';
import lowercaseKeys = require('lowercase-keys');
import Keyv = require('keyv');
import optionsToUrl from './utils/options-to-url';
import supportsBrotli from './utils/supports-brotli';
import merge, {mergeOptions} from './merge';
import knownHookEvents from './known-hook-events';
import {
	Options,
	NormalizedOptions,
	Method,
	URLOrOptions,
	NormalizedDefaults
} from './utils/types';

let hasShownDeprecation = false;

// It's 2x faster than [...new Set(array)]
const uniqueArray = <T>(array: T[]): T[] => array.filter((element, position) => array.indexOf(element) === position);

// `preNormalize` handles static options (e.g. headers).
// For example, when you create a custom instance and make a request
// with no static changes, they won't be normalized again.
//
// `normalize` operates on dynamic options - they cannot be saved.
// For example, `url` needs to be normalized every request.

// TODO: document this.
export const preNormalizeArguments = (options: Options, defaults?: NormalizedOptions): NormalizedOptions => {
	// `options.headers`
	if (is.nullOrUndefined(options.headers)) {
		options.headers = {};
	} else {
		options.headers = lowercaseKeys(options.headers);
	}

	// `options.prefixUrl`
	if (options.prefixUrl) {
		options.prefixUrl = options.prefixUrl.toString();

		if (!options.prefixUrl.endsWith('/')) {
			options.prefixUrl += '/';
		}
	}

	// `options.hooks`
	if (is.nullOrUndefined(options.hooks)) {
		options.hooks = {};
	} else if (is.object(options.hooks)) {
		for (const event of knownHookEvents) {
			if (Reflect.has(options.hooks, event)) {
				if (!is.array(options.hooks[event])) {
					throw new TypeError(`Parameter \`${event}\` must be an Array, not ${is(options.hooks[event])}`);
				}
			} else {
				options.hooks[event] = [];
			}
		}
	} else {
		throw new TypeError(`Parameter \`hooks\` must be an Object, not ${is(options.hooks)}`);
	}

	// `options.timeout`
	if (is.number(options.timeout)) {
		options.timeout = {request: options.timeout};
	} else if (!is.object(options.timeout)) {
		options.timeout = {};
	}

	// `options.retry`
	const {retry} = options;

	if (defaults && Reflect.has(defaults, 'retry')) {
		options.retry = {...defaults.retry};
	} else {
		options.retry = {
			calculateDelay: retryObject => retryObject.computedValue,
			limit: 0,
			methods: [],
			statusCodes: [],
			errorCodes: [],
			maxRetryAfter: undefined
		};
	}

	if (is.object(retry)) {
		options.retry = {
			...options.retry,
			...retry
		};
	} else if (is.number(retry)) {
		options.retry.limit = retry;
	}

	if (options.retry.maxRetryAfter === undefined) {
		options.retry.maxRetryAfter = Math.min(
			...[options.timeout.request, options.timeout.connect].filter(n => !is.nullOrUndefined(n))
		);
	}

	options.retry.methods = uniqueArray(options.retry.methods.map(method => method.toUpperCase())) as Method[];
	options.retry.statusCodes = uniqueArray(options.retry.statusCodes);
	options.retry.errorCodes = uniqueArray(options.retry.errorCodes);

	// `options.dnsCache`
	if (options.dnsCache && !(options instanceof CacheableLookup)) {
		options.dnsCache = new CacheableLookup({cacheAdapter: options.dnsCache as Keyv | undefined});
	}

	return options as NormalizedOptions;
};

export const normalizeArguments = (url: URLOrOptions, options?: Options, defaults?: NormalizedDefaults): NormalizedOptions => {
	// `options.prefixUrl` and UNIX socket support
	if (is.string(url)) {
		if (Reflect.has(options, 'prefixUrl')) {
			if (url.startsWith('/')) {
				throw new Error('`url` must not begin with a slash when using `prefixUrl`');
			} else {
				url = options.prefixUrl.toString() + url;
			}
		}

		url = url.replace(/^unix:/, 'http://$&');
	}

	// TODO: Remove this before Got v11
	if (options.query) {
		if (!hasShownDeprecation) {
			console.warn('`options.query` is deprecated. We support it solely for compatibility - it will be removed in Got 11. Use `options.searchParams` instead.');
			hasShownDeprecation = true;
		}

		options.searchParams = options.query;
		delete options.query;
	}

	// Merge url
	if (is.plainObject(url)) {
		options = mergeOptions(url, options);

		if (!Reflect.has(options, 'url')) {
			if (!Reflect.has(options, 'protocol') && !Reflect.has(options, 'hostname') && !Reflect.has(options, 'host')) {
				throw new TypeError('Missing `protocol` and `hostname` properties.`');
			}

			// TODO: Drop URLOptions support in Got v12
			options.url = optionsToUrl(options);
		}
	} else {
		options = merge({}, options);
		options.url = new URL(url as string);
	}

	// Merge defaults
	if (defaults) {
		if (options) {
			options = mergeOptions(defaults.options, preNormalizeArguments(options, defaults.options));
		}
	} else {
		preNormalizeArguments(options);
	}

	// Cast `options.url` to URL
	options.url = options.url as URL;

	// TODO: normalizing arguments should be done at this point

	for (const hook of options.hooks.init) {
		if (is.asyncFunction(hook)) {
			throw new TypeError('The `init` hook must be a synchronous function');
		}

		// @ts-ignore TS is dumb.
		hook(options);
	}

	if (options.url.hostname === 'unix') {
		const matches = /(?<socketPath>.+?):(?<path>.+)/.exec(options.url.pathname);

		if (matches?.groups) {
			const {socketPath, path} = matches.groups;

			// It's a bug!
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
			options = {
				...options,
				socketPath,
				path,
				host: '',
				url: undefined
			} as NormalizedOptions;
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
