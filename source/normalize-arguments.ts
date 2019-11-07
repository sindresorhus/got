import http = require('http');
import https = require('https');
import CacheableLookup from 'cacheable-lookup';
import CacheableRequest = require('cacheable-request');
import is from '@sindresorhus/is';
import lowercaseKeys = require('lowercase-keys');
import toReadableStream = require('to-readable-stream');
import Keyv = require('keyv');
import optionsToUrl from './utils/options-to-url';
import {UnsupportedProtocolError} from './errors';
import merge, {mergeOptions} from './merge';
import knownHookEvents from './known-hook-events';
import {
	Options,
	NormalizedOptions,
	Method,
	URLOrOptions,
	NormalizedDefaults
} from './utils/types';
import dynamicRequire from './utils/dynamic-require';
import getBodySize from './utils/get-body-size';
import isFormData from './utils/is-form-data';
import supportsBrotli from './utils/supports-brotli';

// TODO: Add this to documentation:
// `preNormalizeArguments` handles options that doesn't change during the whole request (e.g. hooks).
// `normalizeArguments` is only called on `got(...)`. It merges options and normalizes URL.
// `normalizeRequestArguments` converts Got options into HTTP options.

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

	options.retry.methods = [...new Set(options.retry.methods.map(method => method.toUpperCase()))] as Method[];
	options.retry.statusCodes = [...new Set(options.retry.statusCodes)];
	options.retry.errorCodes = [...new Set(options.retry.errorCodes)];

	// `options.dnsCache`
	if (options.dnsCache && !(options instanceof CacheableLookup)) {
		options.dnsCache = new CacheableLookup({cacheAdapter: options.dnsCache as Keyv | undefined});
	}

	// `options.method`
	if (options.method) {
		options.method = options.method.toUpperCase() as Method;
	}

	// Better memory management
	if (Reflect.has(options, 'cache') && options.cache !== false) {
		(options as NormalizedOptions).cacheableRequest = new CacheableRequest((options, handler) => options.request(options, handler), options.cache as any);
	}

	return options as NormalizedOptions;
};

export const normalizeArguments = (url: URLOrOptions, options?: Options, defaults?: NormalizedDefaults): NormalizedOptions => {
	// Merge options
	if (is.string(url)) {
		options = merge({}, options);
		options.url = url;
	} else {
		options = mergeOptions(url, options);

		if (!Reflect.has(options, 'url')) {
			options.url = '';
		}
	}

	// Merge defaults
	if (defaults) {
		options = mergeOptions(defaults.options, preNormalizeArguments(options, defaults.options));
	} else {
		preNormalizeArguments(options);
	}

	// Normalize URL
	if (is.string(options.url)) {
		if (Reflect.has(options, 'prefixUrl')) {
			if (options.url.startsWith('/')) {
				throw new Error('`url` must not begin with a slash when using `prefixUrl`');
			} else {
				options.url = options.prefixUrl.toString() + options.url;
			}
		}

		options.url = new URL(options.url.replace(/^unix:/, 'http://$&'));
	} else if (Reflect.has(options.url, 'resolve')) {
		throw new Error('The legacy `url.Url` is deprecated. Use `URL` instead.');
	} else {
		// TODO: Maybe drop URLOptions support in Got v12
		options.url = optionsToUrl(options.url);
	}

	// Make it possible to remove default headers
	for (const [key, value] of Object.entries(options.headers)) {
		if (is.nullOrUndefined(value)) {
			delete options.headers[key];
		}
	}

	for (const hook of options.hooks.init) {
		if (is.asyncFunction(hook)) {
			throw new TypeError('The `init` hook must be a synchronous function');
		}

		// @ts-ignore TS is dumb.
		hook(options);
	}

	return options as NormalizedOptions;
};

const withoutBody: ReadonlySet<string> = new Set(['GET', 'HEAD']);
type NormalizedRequestArguments = https.RequestOptions & {body: Pick<NormalizedOptions, 'body'>};

export const normalizeRequestArguments = async (options: NormalizedOptions): Promise<NormalizedRequestArguments> => {
	options = merge({}, options);

	let uploadBodySize: number | undefined;

	// Serialize body
	const {body, headers} = options;
	const isForm = !is.nullOrUndefined(options.form);
	const isJSON = !is.nullOrUndefined(options.json);
	const isBody = !is.nullOrUndefined(body);
	if ((isBody || isForm || isJSON) && withoutBody.has(options.method)) {
		throw new TypeError(`The \`${options.method}\` method cannot be used with a body`);
	}

	if (isBody) {
		if (isForm || isJSON) {
			throw new TypeError('The `body` option cannot be used with the `json` option or `form` option');
		}

		if (is.object(body) && isFormData(body)) {
			// Special case for https://github.com/form-data/form-data
			if (!Reflect.has(headers, 'content-type')) {
				headers['content-type'] = `multipart/form-data; boundary=${body.getBoundary()}`;
			}
		} else if (!is.nodeStream(body) && !is.string(body) && !is.buffer(body)) {
			throw new TypeError('The `body` option must be a stream.Readable, string or Buffer');
		}
	} else if (isForm) {
		if (!is.object(options.form)) {
			throw new TypeError('The `form` option must be an Object');
		}

		if (!Reflect.has(headers, 'content-type')) {
			headers['content-type'] = 'application/x-www-form-urlencoded';
		}

		options.body = (new URLSearchParams(options.form as Record<string, string>)).toString();
	} else if (isJSON) {
		if (!Reflect.has(headers, 'content-type')) {
			headers['content-type'] = 'application/json';
		}

		options.body = JSON.stringify(options.json);
	}

	// Convert buffer to stream to receive upload progress events (#322)
	if (is.buffer(body)) {
		options.body = toReadableStream(body);
		uploadBodySize = body.length;
	} else {
		uploadBodySize = await getBodySize(options);
	}

	if (!Reflect.has(headers, 'content-length') && !Reflect.has(headers, 'transfer-encoding')) {
		if ((uploadBodySize > 0 || options.method === 'PUT') && !is.undefined(uploadBodySize)) {
			headers['content-length'] = String(uploadBodySize);
		}
	}

	if (!options.isStream && options.responseType === 'json' && is.undefined(headers.accept)) {
		headers.accept = 'application/json';
	}

	if (options.decompress && is.undefined(headers['accept-encoding'])) {
		headers['accept-encoding'] = supportsBrotli ? 'gzip, deflate, br' : 'gzip, deflate';
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

	if (is.object(options.agent)) {
		options.agent = options.agent[options.url.protocol.slice(0, -1)] || options.agent;
	}

	if (options.dnsCache) {
		options.lookup = options.dnsCache.lookup;
	}

	// Validate URL
	if (options.url.protocol !== 'http:' && options.url.protocol !== 'https:') {
		throw new UnsupportedProtocolError(options);
	}

	decodeURI(options.url.toString());

	// Normalize request function
	if (!is.function_(options.request)) {
		options.request = options.url.protocol === 'https:' ? https.request : http.request;
	}

	/* istanbul ignore next: electron.net is broken */
	// No point in typing process.versions correctly, as
	// `process.version.electron` is used only once, right here.
	if (options.useElectronNet && (process.versions as any).electron) {
		const electron = dynamicRequire(module, 'electron') as any; // Trick webpack
		options.request = electron.net.request ?? electron.remote.net.request;
	}

	return options as unknown as NormalizedRequestArguments;
};
