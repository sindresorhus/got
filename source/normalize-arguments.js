'use strict';
const {URL, URLSearchParams} = require('url'); // TODO: Use the `URL` global when targeting Node.js 10
const is = require('@sindresorhus/is');
const toReadableStream = require('to-readable-stream');
const urlParseLax = require('url-parse-lax');
const isRetryOnNetworkErrorAllowed = require('./is-retry-on-network-error-allowed');
const urlToOptions = require('./url-to-options');
const isFormData = require('./is-form-data');
const knownHookEvents = require('./known-hook-events');
const merge = require('./merge');

const retryAfterStatusCodes = new Set([413, 429, 503]);

// `preNormalize` handles things related to static options, like `baseUrl`, `followRedirect`, `hooks`, etc.
// While `normalize` does `preNormalize` + handles things related to dynamic options, like URL, headers, body, etc.
const preNormalize = options => {
	options = {
		headers: {},
		...options
	};

	if (options.baseUrl && !options.baseUrl.toString().endsWith('/')) {
		options.baseUrl += '/';
	}

	if (is.undefined(options.followRedirect)) {
		options.followRedirect = true;
	}

	if (is.nullOrUndefined(options.hooks)) {
		options.hooks = {};
	}
	if (is.object(options.hooks)) {
		for (const hookEvent of knownHookEvents) {
			const hooks = options.hooks[hookEvent];
			if (is.nullOrUndefined(hooks)) {
				options.hooks[hookEvent] = [];
			} else if (is.array(hooks)) {
				for (const [index, hook] of hooks.entries()) {
					if (!is.function(hook)) {
						throw new TypeError(
							`Parameter \`hooks.${hookEvent}[${index}]\` must be a function, not ${is(hook)}`
						);
					}
				}
			} else {
				throw new TypeError(`Parameter \`hooks.${hookEvent}\` must be an array, not ${is(hooks)}`);
			}
		}
	} else {
		throw new TypeError(`Parameter \`hooks\` must be an object, not ${is(options.hooks)}`);
	}

	return options;
};

module.exports = (url, options, defaults) => {
	options = merge({}, defaults.options, options || {});
	options = preNormalize(options);

	if (Reflect.has(options, 'url') || (is.object(url) && Reflect.has(url, 'url'))) {
		throw new TypeError('Parameter `url` is not an option. Use got(url, options)');
	}

	if (!is.string(url) && !is.object(url)) {
		throw new TypeError(`Parameter \`url\` must be a string or object, not ${is(url)}`);
	}

	if (is.string(url)) {
		if (options.baseUrl) {
			if (url.toString().startsWith('/')) {
				url = url.toString().slice(1);
			}

			url = urlToOptions(new URL(url, options.baseUrl));
		} else {
			url = url.replace(/^unix:/, 'http://$&');

			try {
				decodeURI(url);
			} catch (_) {
				throw new Error('Parameter `url` must contain valid UTF-8 character sequences');
			}

			url = urlParseLax(url);
			if (url.auth) {
				throw new Error('Basic authentication must be done with the `auth` option');
			}
		}
	} else if (is(url) === 'URL') {
		url = urlToOptions(url);
	}

	options = {
		path: '',
		...url,
		protocol: url.protocol || 'http:', // Override both null/undefined with default protocol
		...options
	};

	const {baseUrl} = options;
	Object.defineProperty(options, 'baseUrl', {
		set: () => {
			throw new Error('Failed to set baseUrl. Options are normalized already.');
		},
		get: () => baseUrl
	});

	const {query} = options;
	if (!is.empty(query) || query instanceof URLSearchParams) {
		if (!is.string(query)) {
			options.query = (new URLSearchParams(query)).toString();
		}
		options.path = `${options.path.split('?')[0]}?${options.query}`;
		delete options.query;
	}

	if (options.stream && options.json) {
		options.json = false;
	}

	if (options.json && is.undefined(options.headers.accept)) {
		options.headers.accept = 'application/json';
	}

	const {headers} = options;
	for (const [key, value] of Object.entries(headers)) {
		if (is.nullOrUndefined(value)) {
			delete headers[key];
		}
	}

	const {body} = options;
	if (is.nullOrUndefined(body)) {
		options.method = options.method || 'GET';
	} else {
		const isObject = is.object(body) && !Buffer.isBuffer(body) && !is.nodeStream(body);
		if (!is.nodeStream(body) && !is.string(body) && !is.buffer(body) && !(options.form || options.json)) {
			throw new TypeError('The `body` option must be a stream.Readable, string or Buffer');
		}

		if (options.json && !(isObject || is.array(body))) {
			throw new TypeError('The `body` option must be an Object or Array when the `json` option is used');
		}

		if (options.form && !isObject) {
			throw new TypeError('The `body` option must be an Object when the `form` option is used');
		}

		if (isFormData(body)) {
			// Special case for https://github.com/form-data/form-data
			headers['content-type'] = headers['content-type'] || `multipart/form-data; boundary=${body.getBoundary()}`;
		} else if (options.form) {
			headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';
			options.body = (new URLSearchParams(body)).toString();
		} else if (options.json) {
			headers['content-type'] = headers['content-type'] || 'application/json';
			options.body = JSON.stringify(body);
		}

		// Convert buffer to stream to receive upload progress events (#322)
		if (is.buffer(body)) {
			options.body = toReadableStream(body);
			options.body._buffer = body;
		}

		options.method = options.method || 'POST';
	}

	options.method = options.method.toUpperCase();

	if (options.decompress && is.undefined(options.headers['accept-encoding'])) {
		options.headers['accept-encoding'] = 'gzip, deflate';
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

	options.gotRetry = {retries: 0, methods: [], statusCodes: []};
	if (options.retry !== false) {
		if (is.number(options.retry)) {
			if (is.object(defaults.options.retry)) {
				options.gotRetry = {...defaults.options.retry, retries: options.retry};
			} else {
				options.gotRetry.retries = options.retry;
			}
		} else {
			options.gotRetry = {...options.gotRetry, ...options.retry};
		}
		delete options.retry;
	}

	options.gotRetry.methods = new Set(options.gotRetry.methods.map(method => method.toUpperCase()));
	options.gotRetry.statusCodes = new Set(options.gotRetry.statusCodes);

	if (!options.gotRetry.maxRetryAfter && Reflect.has(options, 'timeout')) {
		if (is.number(options.timeout)) {
			options.gotRetry.maxRetryAfter = options.timeout;
		} else {
			options.gotRetry.maxRetryAfter = Math.min(...[options.timeout.request, options.timeout.connection].filter(n => !is.nullOrUndefined(n)));
		}
	}

	if (is.number(options.timeout) || is.object(options.timeout)) {
		if (is.number(options.timeout)) {
			options.gotTimeout = {request: options.timeout};
		} else {
			options.gotTimeout = options.timeout;
		}
		delete options.timeout;
	}

	if (!is.function(options.gotRetry.retries)) {
		const {retries} = options.gotRetry;

		options.gotRetry.retries = (iteration, error) => {
			if (iteration > retries || (!isRetryOnNetworkErrorAllowed(error) && (!options.gotRetry.methods.has(error.method) || !options.gotRetry.statusCodes.has(error.statusCode)))) {
				return 0;
			}

			if (Reflect.has(error, 'headers') && Reflect.has(error.headers, 'retry-after') && retryAfterStatusCodes.has(error.statusCode)) {
				let after = Number(error.headers['retry-after']);
				if (is.nan(after)) {
					after = Date.parse(error.headers['retry-after']) - Date.now();
				} else {
					after *= 1000;
				}

				if (after > options.gotRetry.maxRetryAfter) {
					return 0;
				}

				return after;
			}

			if (error.statusCode === 413) {
				return 0;
			}

			const noise = Math.random() * 100;

			return ((1 << iteration) * 1000) + noise;
		};
	}

	return options;
};

module.exports.preNormalize = preNormalize;
