import {promisify} from 'util';
import CacheableRequest = require('cacheable-request');
import http = require('http');
import https = require('https');
import Keyv = require('keyv');
import lowercaseKeys = require('lowercase-keys');
import stream = require('stream');
import toReadableStream = require('to-readable-stream');
import is from '@sindresorhus/is';
import CacheableLookup from 'cacheable-lookup';
import {Merge} from 'type-fest';
import {UnsupportedProtocolError} from './errors';
import knownHookEvents from './known-hook-events';
import dynamicRequire from './utils/dynamic-require';
import getBodySize from './utils/get-body-size';
import isFormData from './utils/is-form-data';
import merge from './utils/merge';
import optionsToUrl from './utils/options-to-url';
import supportsBrotli from './utils/supports-brotli';
import {
	AgentByProtocol,
	Defaults,
	Method,
	NormalizedOptions,
	Options,
	RequestFunction,
	URLOrOptions
} from './utils/types';

// `preNormalizeArguments` normalizes these options: `headers`, `prefixUrl`, `hooks`, `timeout`, `retry` and `method`.
// `normalizeArguments` is *only* called on `got(...)`. It normalizes the URL and performs `mergeOptions(...)`.
// `normalizeRequestArguments` converts Got options into HTTP options.

type NonEnumerableProperty = 'context' | 'body' | 'json' | 'form';
const nonEnumerableProperties: NonEnumerableProperty[] = [
	'context',
	'body',
	'json',
	'form'
];

const isAgentByProtocol = (agent: Options['agent']): agent is AgentByProtocol => is.object(agent);

// TODO: `preNormalizeArguments` should merge `options` & `defaults`
export const preNormalizeArguments = (options: Options, defaults?: NormalizedOptions): NormalizedOptions => {
	// `options.headers`
	if (is.undefined(options.headers)) {
		options.headers = {};
	} else {
		options.headers = lowercaseKeys(options.headers);
	}

	for (const [key, value] of Object.entries(options.headers)) {
		if (is.null_(value)) {
			throw new TypeError(`Use \`undefined\` instead of \`null\` to delete the \`${key}\` header`);
		}
	}

	// `options.prefixUrl`
	if (is.urlInstance(options.prefixUrl) || is.string(options.prefixUrl)) {
		options.prefixUrl = options.prefixUrl.toString();

		if (options.prefixUrl.length !== 0 && !options.prefixUrl.endsWith('/')) {
			options.prefixUrl += '/';
		}
	} else {
		options.prefixUrl = defaults ? defaults.prefixUrl : '';
	}

	// `options.hooks`
	if (is.undefined(options.hooks)) {
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
			if (!(Reflect.has(options.hooks, event) && is.undefined(options.hooks[event]))) {
				// @ts-ignore Union type array is not assignable to union array type
				options.hooks[event] = [
					...defaults.hooks[event],
					...options.hooks[event]!
				];
			}
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
		// @ts-ignore We assign if it is undefined, so this IS correct
		options.retry.maxRetryAfter = Math.min(
			...[options.timeout.request, options.timeout.connect].filter((n): n is number => !is.nullOrUndefined(n))
		);
	}

	options.retry.methods = [...new Set(options.retry.methods!.map(method => method.toUpperCase() as Method))];
	options.retry.statusCodes = [...new Set(options.retry.statusCodes)];
	options.retry.errorCodes = [...new Set(options.retry.errorCodes)];

	// `options.dnsCache`
	if (options.dnsCache && !(options.dnsCache instanceof CacheableLookup)) {
		options.dnsCache = new CacheableLookup({cacheAdapter: options.dnsCache as Keyv});
	}

	// `options.method`
	if (is.string(options.method)) {
		options.method = options.method.toUpperCase() as Method;
	} else {
		options.method = defaults?.method ?? 'GET';
	}

	// Better memory management, so we don't have to generate a new object every time
	if (options.cache) {
		(options as NormalizedOptions).cacheableRequest = new CacheableRequest(
			// @ts-ignore Types broke on infer
			(requestOptions, handler) => requestOptions.request(requestOptions, handler),
			options.cache
		);
	}

	// `options.cookieJar`
	if (is.object(options.cookieJar)) {
		let {setCookie, getCookieString} = options.cookieJar;

		// Horrible `tough-cookie` check
		if (setCookie.length === 4 && getCookieString.length === 0) {
			if (!Reflect.has(setCookie, promisify.custom)) {
				// @ts-ignore We check for non-promisified setCookie, so this IS correct
				setCookie = promisify(setCookie.bind(options.cookieJar));
				getCookieString = promisify(getCookieString.bind(options.cookieJar));
			}
		} else if (setCookie.length !== 2) {
			throw new TypeError('`options.cookieJar.setCookie` needs to be an async function with 2 arguments');
		} else if (getCookieString.length !== 1) {
			throw new TypeError('`options.cookieJar.getCookieString` needs to be an async function with 1 argument');
		}

		options.cookieJar = {setCookie, getCookieString};
	}

	// `options.encoding`
	if (is.null_(options.encoding)) {
		throw new TypeError('To get a Buffer, set `options.responseType` to `buffer` instead');
	}

	// `options.maxRedirects`
	if (!Reflect.has(options, 'maxRedirects') && !(defaults && Reflect.has(defaults, 'maxRedirects'))) {
		options.maxRedirects = 0;
	}

	return options as NormalizedOptions;
};

export const mergeOptions = (...sources: Options[]): NormalizedOptions => {
	const mergedOptions = preNormalizeArguments({});

	// Non enumerable properties shall not be merged
	const properties: Partial<{[Key in NonEnumerableProperty]: any}> = {};

	for (const source of sources) {
		merge(mergedOptions, preNormalizeArguments(merge({}, source), mergedOptions));

		for (const name of nonEnumerableProperties) {
			if (!Reflect.has(source, name)) {
				continue;
			}

			properties[name] = {
				writable: true,
				configurable: true,
				enumerable: false,
				value: source[name]
			};
		}
	}

	Object.defineProperties(mergedOptions, properties);

	return mergedOptions;
};

export const normalizeArguments = (url: URLOrOptions, options?: Options, defaults?: Defaults): NormalizedOptions => {
	// Merge options
	if (typeof url === 'undefined') {
		throw new TypeError('Missing `url` argument');
	}

	if (typeof options === 'undefined') {
		options = {};
	}

	if (is.urlInstance(url) || is.string(url)) {
		options.url = url;

		options = mergeOptions(defaults?.options ?? {}, options);
	} else {
		if (Reflect.has(url, 'resolve')) {
			throw new Error('The legacy `url.Url` is deprecated. Use `URL` instead.');
		}

		options = mergeOptions(defaults?.options ?? {}, url, options);
	}

	// Normalize URL
	// TODO: drop `optionsToUrl` in Got 12
	if (is.string(options.url)) {
		options.url = (options.prefixUrl as string) + options.url;
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
	Object.defineProperty(normalizedOptions, 'prefixUrl', {
		set: (value: string) => {
			if (!normalizedOptions.url.href.startsWith(value)) {
				throw new Error(`Cannot change \`prefixUrl\` from ${prefixUrl} to ${value}: ${normalizedOptions.url.href}`);
			}

			normalizedOptions.url = new URL(value + normalizedOptions.url.href.slice(prefixUrl.length));
			prefixUrl = value;
		},
		get: () => prefixUrl
	});

	// Make it possible to remove default headers
	for (const [key, value] of Object.entries(normalizedOptions.headers)) {
		if (is.undefined(value)) {
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete normalizedOptions.headers[key];
		}
	}

	for (const hook of normalizedOptions.hooks.init) {
		const result = hook(normalizedOptions);

		if (is.promise(result)) {
			throw new TypeError('The `init` hook must be a synchronous function');
		}
	}

	return normalizedOptions;
};

const withoutBody: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export type NormalizedRequestArguments = Merge<https.RequestOptions, {
	body?: stream.Readable;
	request: RequestFunction;
	url: Pick<NormalizedOptions, 'url'>;
}>;

export const normalizeRequestArguments = async (options: NormalizedOptions): Promise<NormalizedRequestArguments> => {
	options = mergeOptions(options);

	// Serialize body
	const {headers} = options;
	const noContentType = is.undefined(headers['content-type']);

	{
		// TODO: these checks should be moved to `preNormalizeArguments`
		const isForm = !is.undefined(options.form);
		const isJSON = !is.undefined(options.json);
		const isBody = !is.undefined(options.body);
		if ((isBody || isForm || isJSON) && withoutBody.has(options.method)) {
			throw new TypeError(`The \`${options.method}\` method cannot be used with a body`);
		}

		if ([isBody, isForm, isJSON].filter(isTrue => isTrue).length > 1) {
			throw new TypeError('The `body`, `json` and `form` options are mutually exclusive');
		}

		if (
			isBody &&
			!is.nodeStream(options.body) &&
			!is.string(options.body) &&
			!is.buffer(options.body) &&
			!(is.object(options.body) && isFormData(options.body))
		) {
			throw new TypeError('The `body` option must be a stream.Readable, string or Buffer');
		}

		if (isForm && !is.object(options.form)) {
			throw new TypeError('The `form` option must be an Object');
		}
	}

	if (options.body) {
		// Special case for https://github.com/form-data/form-data
		if (is.object(options.body) && isFormData(options.body) && noContentType) {
			headers['content-type'] = `multipart/form-data; boundary=${options.body.getBoundary()}`;
		}
	} else if (options.form) {
		if (noContentType) {
			headers['content-type'] = 'application/x-www-form-urlencoded';
		}

		options.body = (new URLSearchParams(options.form as Record<string, string>)).toString();
	} else if (options.json) {
		if (noContentType) {
			headers['content-type'] = 'application/json';
		}

		options.body = JSON.stringify(options.json);
	}

	const uploadBodySize = await getBodySize(options);

	if (!is.nodeStream(options.body)) {
		options.body = toReadableStream(options.body!);
	}

	// See https://tools.ietf.org/html/rfc7230#section-3.3.2
	// A user agent SHOULD send a Content-Length in a request message when
	// no Transfer-Encoding is sent and the request method defines a meaning
	// for an enclosed payload body.  For example, a Content-Length header
	// field is normally sent in a POST request even when the value is 0
	// (indicating an empty payload body).  A user agent SHOULD NOT send a
	// Content-Length header field when the request message does not contain
	// a payload body and the method semantics do not anticipate such a
	// body.
	if (noContentType && is.undefined(headers['transfer-encoding'])) {
		if (
			(options.method === 'POST' || options.method === 'PUT' || options.method === 'PATCH') &&
			!is.undefined(uploadBodySize)
		) {
			// @ts-ignore We assign if it is undefined, so this IS correct
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

			options = {
				...options,
				socketPath,
				path,
				host: ''
			};
		}
	}

	if (isAgentByProtocol(options.agent)) {
		options.agent = options.agent[options.url.protocol.slice(0, -1) as keyof AgentByProtocol] ?? options.agent;
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

	// Got's `timeout` is an object, http's `timeout` is a number, so they're not compatible.
	delete options.timeout;

	// Set cookies
	if (options.cookieJar) {
		const cookieString = await options.cookieJar.getCookieString(options.url.toString());

		if (is.nonEmptyString(cookieString)) {
			options.headers.cookie = cookieString;
		} else {
			delete options.headers.cookie;
		}
	}

	// `http-cache-semantics` checks this
	delete options.url;

	return options as unknown as NormalizedRequestArguments;
};
