import urlLib, {URL, URLSearchParams} from 'url'; // TODO: Use the `URL` global when targeting Node.js 10
import CacheableLookup from 'cacheable-lookup';
import is from '@sindresorhus/is';
import lowercaseKeys from 'lowercase-keys';
import urlToOptions from './utils/url-to-options';
import validateSearchParams from './utils/validate-search-params';
import supportsBrotli from './utils/supports-brotli';
import merge from './merge';
import knownHookEvents from './known-hook-events';

const retryAfterStatusCodes = new Set([413, 429, 503]);

let shownDeprecation = false;

// `preNormalize` handles static options (e.g. headers).
// For example, when you create a custom instance and make a request
// with no static changes, they won't be normalized again.
//
// `normalize` operates on dynamic options - they cannot be saved.
// For example, `body` is everytime different per request.
// When it's done normalizing the new options, it performs merge()
// on the prenormalized options and the normalized ones.

export const preNormalizeArguments = (options: any, defaults?: any) => {
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
			if (defaults) {
				options.hooks[event] = [...defaults.hooks[event]];
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
		options.retry = {...defaults.retry};
	}

	if (retry !== false) {
		if (is.number(retry)) {
			options.retry.retries = retry;
		} else {
			options.retry = {...options.retry, ...retry};
		}
	}

	if (!options.retry.maxRetryAfter && options.gotTimeout) {
		options.retry.maxRetryAfter = Math.min(...[options.gotTimeout.request, options.gotTimeout.connection].filter(n => !is.nullOrUndefined(n)));
	}

	if (is.array(options.retry.methods)) {
		options.retry.methods = new Set(options.retry.methods.map(method => method.toUpperCase()));
	}

	if (is.array(options.retry.statusCodes)) {
		options.retry.statusCodes = new Set(options.retry.statusCodes);
	}

	if (is.array(options.retry.errorCodes)) {
		options.retry.errorCodes = new Set(options.retry.errorCodes);
	}

	if (options.dnsCache) {
		const cacheableLookup = new CacheableLookup({cacheAdapter: options.dnsCache});
		options.lookup = cacheableLookup.lookup;
		delete options.dnsCache;
	}

	return options;
};

export const normalizeArguments = (url, options, defaults?: any) => {
	if (is.plainObject(url)) {
		options = {...url, ...options};
		url = options.url || '';
		delete options.url;
	}

	if (defaults) {
		options = merge({}, defaults.options, options ? preNormalizeArguments(options, defaults.options) : {});
	} else {
		options = merge({}, preNormalizeArguments(options));
	}

	if (!is.string(url) && !is.object(url)) {
		throw new TypeError(`Parameter \`url\` must be a string or object, not ${is(url)}`);
	}

	if (is.string(url) && !(url === '' && !options.baseUrl)) {
		if (options.baseUrl) {
			if (url.startsWith('/')) {
				url = url.slice(1);
			}
		} else {
			url = url.replace(/^unix:/, 'http://$&');
		}

		url = urlToOptions(new URL(url, options.baseUrl));
	} else if (is(url) === 'URL') {
		url = urlToOptions(url);
	}

	// Override both null/undefined with default protocol
	options = merge({path: ''}, url, {protocol: url.protocol || 'https:'}, options);

	for (const hook of options.hooks.init) {
		const called = hook(options);

		if (is.promise(called)) {
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

	if (options.query) {
		if (!shownDeprecation) {
			console.warn('`options.query` is deprecated. We support it solely for compatibility - it will be removed in Got 11. Use `options.searchParams` instead.');
			shownDeprecation = true;
		}

		searchParams = options.query;
		delete options.query;
	}

	// TODO: This should be used in the `options` type instead
	interface SearchParams {
		[key: string]: string | number | boolean | null;
	}

	if (is.nonEmptyString(searchParams) || is.nonEmptyObject(searchParams) || searchParams instanceof URLSearchParams) {
		if (!is.string(searchParams)) {
			if (!(searchParams instanceof URLSearchParams)) {
				validateSearchParams(searchParams);
				searchParams = searchParams as SearchParams;
			}

			searchParams = (new URLSearchParams(searchParams)).toString();
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
				host: null
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
		options.method = options.method.toUpperCase();
	}

	if (!is.function_(options.retry.retries)) {
		const {retries} = options.retry;

		options.retry.retries = (iteration, error) => {
			if (iteration > retries) {
				return 0;
			}

			const hasCode = !is.undefined(error.code) && options.retry.errorCodes.has(error.code);
			const hasMethod = !is.undefined(error.method) && options.retry.methods.has(error.method);
			const hasStatusCode = !is.undefined(error.statusCode) && options.retry.statusCodes.has(error.statusCode);
			if ((!error || !hasCode) && (!hasMethod || !hasStatusCode)) {
				return 0;
			}

			if (Reflect.has(error, 'headers') && Reflect.has(error.headers, 'retry-after') && retryAfterStatusCodes.has(error.statusCode)) {
				let after = Number(error.headers['retry-after']);
				if (is.nan(after)) {
					after = Date.parse(error.headers['retry-after']) - Date.now();
				} else {
					after *= 1000;
				}

				if (after > options.retry.maxRetryAfter) {
					return 0;
				}

				return after;
			}

			if (error.statusCode === 413) {
				return 0;
			}

			const noise = Math.random() * 100;
			return ((2 ** (iteration - 1)) * 1000) + noise;
		};
	}

	return options;
};

export const reNormalizeArguments = options => normalizeArguments(urlLib.format(options), options);
