import {URL, URLSearchParams} from 'url';
import {promisify, deprecate} from 'util';
import CacheableRequest = require('cacheable-request');
import http = require('http');
import https = require('https');
import Keyv = require('keyv');
import caseless = require('caseless');
import stream = require('stream');
import toReadableStream = require('to-readable-stream');
import is from '@sindresorhus/is';
import CacheableLookup from 'cacheable-lookup';
import {Merge} from 'type-fest';
import {UnsupportedProtocolError} from './errors';
import knownHookEvents, {InitHook} from './known-hook-events';
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
	URLOrOptions,
	requestSymbol
} from './types';

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
	// Caseless's typing's second argument is incorrect
	caseless.httpify(options, options.headers!);

	for (const [key, value] of Object.entries(options.headers!)) {
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
			// @ts-ignore Cannot properly type a function with multiple definitions yet
			(requestOptions, handler) => requestOptions[requestSymbol](requestOptions, handler),
			options.cache
		);
	}

	// `options.cookieJar`
	if (is.object(options.cookieJar)) {
		let {setCookie, getCookieString} = options.cookieJar;

		// Horrible `tough-cookie` check
		if (setCookie.length === 4 && getCookieString.length === 0) {
			if (!Reflect.has(setCookie, promisify.custom)) {
				// @ts-ignore TS is dumb - it says `setCookie` is `never`.
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

	// Merge defaults
	if (defaults) {
		options = merge({}, defaults, options);
	}

	// `options._pagination`
	if (is.object(options._pagination)) {
		const {_pagination: pagination} = options;

		if (!is.function_(pagination.transform)) {
			throw new TypeError('`options._pagination.transform` must be implemented');
		}

		if (!is.function_(pagination.shouldContinue)) {
			throw new TypeError('`options._pagination.shouldContinue` must be implemented');
		}

		if (!is.function_(pagination.filter)) {
			throw new TypeError('`options._pagination.filter` must be implemented');
		}

		if (!is.function_(pagination.paginate)) {
			throw new TypeError('`options._pagination.paginate` must be implemented');
		}
	}

	// Other values
	options.decompress = Boolean(options.decompress);
	options.isStream = Boolean(options.isStream);
	options.throwHttpErrors = Boolean(options.throwHttpErrors);
	options.ignoreInvalidCookies = Boolean(options.ignoreInvalidCookies);
	options.cache = options.cache ?? false;
	options.responseType = options.responseType ?? 'text';
	options.resolveBodyOnly = Boolean(options.resolveBodyOnly);
	options.followRedirect = Boolean(options.followRedirect);
	options.dnsCache = options.dnsCache ?? false;
	options.useElectronNet = Boolean(options.useElectronNet);
	options.methodRewriting = Boolean(options.methodRewriting);
	options.allowGetBody = Boolean(options.allowGetBody);
	options.context = options.context ?? {};

	return options as NormalizedOptions;
};

export const mergeOptions = (...sources: Options[]): NormalizedOptions => {
	let mergedOptions = preNormalizeArguments({});

	// Non enumerable properties shall not be merged
	const properties: Partial<{[Key in NonEnumerableProperty]: any}> = {};

	for (const source of sources) {
		mergedOptions = preNormalizeArguments(merge({}, source), mergedOptions);

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

	const runInitHooks = (hooks?: InitHook[], options?: Options): void => {
		if (hooks && options) {
			for (const hook of hooks) {
				const result = hook(options);

				if (is.promise(result)) {
					throw new TypeError('The `init` hook must be a synchronous function');
				}
			}
		}
	};

	const hasUrl = is.urlInstance(url) || is.string(url);
	if (hasUrl) {
		if (options) {
			if (Reflect.has(options, 'url')) {
				throw new TypeError('The `url` option cannot be used if the input is a valid URL.');
			}
		} else {
			options = {};
		}

		// @ts-ignore URL is not URL
		options.url = url;

		runInitHooks(defaults?.options.hooks.init, options);
		runInitHooks(options.hooks?.init, options);
	} else if (Reflect.has(url as object, 'resolve')) {
		throw new Error('The legacy `url.Url` is deprecated. Use `URL` instead.');
	} else {
		runInitHooks(defaults?.options.hooks.init, url as Options);
		runInitHooks((url as Options).hooks?.init, url as Options);

		if (options) {
			runInitHooks(defaults?.options.hooks.init, options);
			runInitHooks(options.hooks?.init, options);
		}
	}

	if (hasUrl) {
		options = mergeOptions(defaults?.options ?? {}, options ?? {});
	} else {
		options = mergeOptions(defaults?.options ?? {}, url as object, options ?? {});
	}

	// Normalize URL
	// TODO: drop `optionsToUrl` in Got 12
	if (is.string(options.url)) {
		options.url = (options.prefixUrl as string) + options.url;
		options.url = options.url.replace(/^unix:/, 'http://$&');

		if (options.searchParams || options.search) {
			options.url = options.url.split('?')[0];
		}

		// @ts-ignore URL is not URL
		options.url = optionsToUrl({
			origin: options.url,
			...options
		});
	} else if (!is.urlInstance(options.url)) {
		// @ts-ignore URL is not URL
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

	return normalizedOptions;
};

const withoutBody: ReadonlySet<string> = new Set(['HEAD']);
const withoutBodyUnlessSpecified = 'GET';

export type NormalizedRequestArguments = Merge<https.RequestOptions, {
	body?: stream.Readable;
	[requestSymbol]: RequestFunction;
	url: Pick<NormalizedOptions, 'url'>;
}>;

export const normalizeRequestArguments = async (options: NormalizedOptions): Promise<NormalizedRequestArguments> => {
	options = mergeOptions(options);

	// Serialize body
	const hasNoContentType = is.undefined(options.getHeader('content-type'));

	{
		// TODO: these checks should be moved to `preNormalizeArguments`
		const isForm = !is.undefined(options.form);
		const isJson = !is.undefined(options.json);
		const isBody = !is.undefined(options.body);
		if ((isBody || isForm || isJson) && withoutBody.has(options.method)) {
			throw new TypeError(`The \`${options.method}\` method cannot be used with a body`);
		}

		if (!options.allowGetBody && (isBody || isForm || isJson) && withoutBodyUnlessSpecified === options.method) {
			throw new TypeError(`The \`${options.method}\` method cannot be used with a body`);
		}

		if ([isBody, isForm, isJson].filter(isTrue => isTrue).length > 1) {
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
		if (is.object(options.body) && isFormData(options.body) && hasNoContentType) {
			options.setHeader('content-type', `multipart/form-data; boundary=${options.body.getBoundary()}`);
		}
	} else if (options.form) {
		if (hasNoContentType) {
			options.setHeader('content-type', 'application/x-www-form-urlencoded');
		}

		options.body = (new URLSearchParams(options.form as Record<string, string>)).toString();
	} else if (options.json) {
		if (hasNoContentType) {
			options.setHeader('content-type', 'application/json');
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
	if (is.undefined(options.getHeader('content-length')) && is.undefined(options.getHeader('transfer-encoding'))) {
		if (
			(options.method === 'POST' || options.method === 'PUT' || options.method === 'PATCH' || options.method === 'DELETE' || (options.allowGetBody && options.method === 'GET')) &&
			!is.undefined(uploadBodySize)
		) {
			options.setHeader('content-length', String(uploadBodySize));
		}
	}

	if (!options.isStream && options.responseType === 'json' && is.undefined(options.getHeader('accept'))) {
		options.setHeader('accept', 'application/json');
	}

	if (options.decompress && is.undefined(options.getHeader('accept-encoding'))) {
		options.setHeader('accept-encoding', supportsBrotli ? 'gzip, deflate, br' : 'gzip, deflate');
	}

	// Validate URL
	if (options.url.protocol !== 'http:' && options.url.protocol !== 'https:') {
		throw new UnsupportedProtocolError(options);
	}

	decodeURI(options.url.toString());

	// Normalize request function
	if (is.function_(options.request)) {
		options[requestSymbol] = options.request;
		delete options.request;
	} else {
		options[requestSymbol] = options.url.protocol === 'https:' ? https.request : http.request;
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
		options.request = deprecate(
			electron.net.request ?? electron.remote.net.request,
			'Electron support has been deprecated and will be removed in Got 11.\n' +
			'See https://github.com/sindresorhus/got/issues/899 for further information.',
			'GOT_ELECTRON'
		);
	}

	// Got's `timeout` is an object, http's `timeout` is a number, so they're not compatible.
	delete options.timeout;

	// Set cookies
	if (options.cookieJar) {
		const cookieString = await options.cookieJar.getCookieString(options.url.toString());

		if (is.nonEmptyString(cookieString)) {
			options.setHeader('cookie', cookieString);
		} else {
			options.removeHeader('cookie');
		}
	}

	// `http-cache-semantics` checks this
	delete options.url;

	return options as unknown as NormalizedRequestArguments;
};
