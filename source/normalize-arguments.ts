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
import merge from './merge';
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
// `preNormalizeArguments` normalizes these options: `headers`, `prefixUrl`, `hooks`, `timeout`, `retry` and `method`.
// `normalizeArguments` is *only* called on `got(...)`. It normalizes the URL and performs `mergeOptions(...)`.
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
	}

	if (is.object(options.hooks)) {
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

	if (defaults) {
		for (const event of knownHookEvents) {
			// @ts-ignore TS is dumb.
			options.hooks[event] = [
				...defaults.hooks[event],
				...options.hooks[event]
			];
		}
	}

	// `options.timeout`
	if (is.number(options.timeout)) {
		options.timeout = {request: options.timeout};
	} else if (!is.object(options.timeout)) {
		options.timeout = {};
	}

	// `options.retry`
	const {retry} = options;

	if (defaults) {
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

	// Better memory management, so we don't have to generate a new object every time
	if (Reflect.has(options, 'cache') && options.cache !== false) {
		(options as NormalizedOptions).cacheableRequest = new CacheableRequest(
			(options, handler) => options.request(options, handler),
			options.cache as any
		);
	}

	return options as NormalizedOptions;
};

export const mergeOptions = (...sources: Options[]): NormalizedOptions => {
	sources = sources.map(source => merge({}, source || {}));

	let defaults = preNormalizeArguments(sources[0]);
	let mergedOptions: NormalizedOptions = defaults;

	for (let index = 1; index < sources.length; index++) {
		mergedOptions = merge({}, defaults, preNormalizeArguments(sources[index], defaults));
		defaults = mergedOptions;
	}

	for (const source of sources) {
		// We need to check `source` to allow calling `.extend()` with no arguments.
		if (!source) {
			continue;
		}

		if (Reflect.has(source, 'context')) {
			Object.defineProperty(mergedOptions, 'context', {
				writable: true,
				configurable: true,
				enumerable: false,
				// @ts-ignore
				value: source.context
			});
		}

		if (Reflect.has(source, 'body')) {
			mergedOptions.body = source.body;
		}

		if (Reflect.has(source, 'json')) {
			mergedOptions.json = source.json;
		}

		if (Reflect.has(source, 'form')) {
			mergedOptions.form = source.form;
		}
	}

	return mergedOptions;
};

export const normalizeArguments = (url: URLOrOptions, options?: Options, defaults?: NormalizedDefaults): NormalizedOptions => {
	// Merge options
	if (typeof url === 'undefined') {
		throw new TypeError('Missing `url` argument.');
	}

	if (typeof options === 'undefined') {
		options = {};
	}

	if (is.urlInstance(url) || is.string(url)) {
		options.url = url;

		options = mergeOptions(defaults && defaults.options, options);
	} else {
		if (Reflect.has(url, 'resolve')) {
			throw new Error('The legacy `url.Url` is deprecated. Use `URL` instead.');
		}

		options = mergeOptions(defaults && defaults.options, url, options);
	}

	// Normalize URL
	if (is.string(options.url)) {
		if (options.prefixUrl) {
			options.url = (options.prefixUrl as string) + options.url;
		}

		options.url = options.url.replace(/^unix:/, 'http://$&');

		if (options.searchParams || options.search) {
			options.url = options.url.split('?')[0];
		}

		options.url = optionsToUrl({
			origin: options.url,
			...options
		});
	} else if (!is.urlInstance(options.url)) {
		options.url = optionsToUrl({origin: options.prefixUrl as string, ...options});
	}

	const normalizedOptions = options as NormalizedOptions;

	// Make it possible to change `options.prefixUrl`
	let prefixUrl = options.prefixUrl as string;
	Object.defineProperty(options, 'prefixUrl', {
		set: (value: string) => {
			if (normalizedOptions.url.href.startsWith(value)) {
				throw new Error(`Cannot change \`prefixUrl\` from ${prefixUrl} to ${value}: ${normalizedOptions.url.href}`);
			}

			normalizedOptions.url = new URL(value + normalizedOptions.url.href.slice(prefixUrl.length));
			prefixUrl = value;
		},
		get: () => prefixUrl
	});

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
		hook(normalizedOptions);
	}

	return normalizedOptions;
};

const withoutBody: ReadonlySet<string> = new Set(['GET', 'HEAD']);

type NormalizedRequestArguments = https.RequestOptions & {
	body: Pick<NormalizedOptions, 'body'>;
	url: Pick<NormalizedOptions, 'url'>;
};

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

	// Validate URL
	if (options.url.protocol !== 'http:' && options.url.protocol !== 'https:') {
		throw new UnsupportedProtocolError(options);
	}

	decodeURI(options.url.toString());

	// Normalize request function
	if (!is.function_(options.request)) {
		options.request = options.url.protocol === 'https:' ? https.request : http.request;
	}

	// UNIX sockets
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

	/* istanbul ignore next: electron.net is broken */
	// No point in typing process.versions correctly, as
	// `process.version.electron` is used only once, right here.
	if (options.useElectronNet && (process.versions as any).electron) {
		const electron = dynamicRequire(module, 'electron') as any; // Trick webpack
		options.request = electron.net.request ?? electron.remote.net.request;
	}

	return options as unknown as NormalizedRequestArguments;
};
