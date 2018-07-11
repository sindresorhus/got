'use strict';
const URLSearchParamsGlobal = typeof URLSearchParams === 'undefined' ? require('url').URLSearchParams : URLSearchParams; // TODO: Use the `URL` global when targeting Node.js 10
const is = require('@sindresorhus/is');
const toReadableStream = require('to-readable-stream');
const urlParseLax = require('url-parse-lax');
const isRetryOnNetworkErrorAllowed = require('./is-retry-allowed');
const urlToOptions = require('./url-to-options');
const isFormData = require('./is-form-data');

const RetryAfterStatusCodes = new Set([413, 429, 503]);

module.exports = (url, options) => {
	if (!is.string(url) && !is.object(url)) {
		throw new TypeError(`Parameter \`url\` must be a string or object, not ${is(url)}`);
	} else if (is.string(url)) {
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
	} else if (is(url) === 'URL') {
		url = urlToOptions(url);
	}

	options = {
		path: '',
		...url,
		protocol: url.protocol || 'http:', // Override both null/undefined with default protocol
		...options
	};

	if (options.decompress && is.undefined(options.headers['accept-encoding'])) {
		options.headers['accept-encoding'] = 'gzip, deflate';
	}

	const {query} = options;
	if (query) {
		if (!is.string(query)) {
			options.query = (new URLSearchParamsGlobal(query)).toString();
		}

		options.path = `${options.path.split('?')[0]}?${options.query}`;
		delete options.query;
	}

	if (options.json && is.undefined(options.headers.accept)) {
		options.headers.accept = 'application/json';
	}

	const {body} = options;
	if (is.nullOrUndefined(body)) {
		options.method = (options.method || 'GET').toUpperCase();
	} else {
		const {headers} = options;
		if (!is.nodeStream(body) && !is.string(body) && !is.buffer(body) && !(options.form || options.json)) {
			throw new TypeError('The `body` option must be a stream.Readable, string or Buffer');
		}

		if (options.json && !(is.plainObject(body) || is.array(body))) {
			throw new TypeError('The `body` option must be a plain Object or Array when the `json` option is used');
		}

		if (options.form && !is.plainObject(body)) {
			throw new TypeError('The `body` option must be a plain Object when the `form` option is used');
		}

		if (isFormData(body)) {
			// Special case for https://github.com/form-data/form-data
			headers['content-type'] = headers['content-type'] || `multipart/form-data; boundary=${body.getBoundary()}`;
		} else if (options.form && is.plainObject(body)) {
			headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';
			options.body = (new URLSearchParamsGlobal(body)).toString();
		} else if (options.json && (is.plainObject(body) || is.array(body))) {
			headers['content-type'] = headers['content-type'] || 'application/json';
			options.body = JSON.stringify(body);
		}

		if (is.undefined(headers['content-length']) && is.undefined(headers['transfer-encoding']) && !is.nodeStream(body)) {
			const length = is.string(options.body) ? Buffer.byteLength(options.body) : options.body.length;
			headers['content-length'] = length;
		}

		// Convert buffer to stream to receive upload progress events (#322)
		if (is.buffer(body)) {
			options.body = toReadableStream(body);
			options.body._buffer = body;
		}

		options.method = (options.method || 'POST').toUpperCase();
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

	options.gotRetry = {retry: 0, methods: [], statusCodes: []};
	if (options.retry !== false) {
		options.gotRetry = {...options.gotRetry, ...options.retry};
	}
	delete options.retry;

	options.gotRetry.methods = new Set(options.gotRetry.methods.map(method => method.toUpperCase()));
	options.gotRetry.statusCodes = new Set(options.gotRetry.statusCodes);

	if (Reflect.has(options.gotRetry, 'maxRetryAfter')) {
		options.gotRetry.maxRetryAfter = options.maxRetryAfter;
	} else {
		options.gotRetry.maxRetryAfter = Math.min(options.gotRetry.request, options.gotRetry.connection);
	}

	if (!is.function(options.gotRetry.retries)) {
		const {retries} = options.gotRetry;

		options.gotRetry.retries = (iteration, error) => {
			if (iteration > retries || (!isRetryOnNetworkErrorAllowed(error) && (!options.gotRetry.methods.has(error.method) || !options.gotRetry.statusCodes.has(error.statusCode)))) {
				return 0;
			}

			if (Reflect.has(error, 'headers') && Reflect.has(error.headers, 'retry-after') && RetryAfterStatusCodes.has(error.statusCode)) {
				let after = Number(error.headers['retry-after']);
				if (is.number(after)) {
					after *= 1000;
				} else {
					after = Math.max(Date.parse(error.headers['retry-after']) - Date.now(), 0);
				}

				if (after > options.gotRetry.maxRetryAfter) {
					return 0;
				}

				return after;
			}

			const noise = Math.random() * 100;

			return ((1 << iteration) * 1000) + noise;
		};
	}

	if (is.undefined(options.followRedirect)) {
		options.followRedirect = true;
	}

	if (is.number(options.timeout) || is.object(options.timeout)) {
		if (is.number(options.timeout)) {
			options.gotTimeout = {request: options.timeout};
		} else {
			options.gotTimeout = options.timeout;
		}
		delete options.timeout;
	}

	return options;
};
