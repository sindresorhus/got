'use strict';
var EventEmitter = require('events').EventEmitter;
var http = require('http');
var https = require('https');
var urlLib = require('url');
var querystring = require('querystring');
var objectAssign = require('object-assign');
var duplexify = require('duplexify');
var isStream = require('is-stream');
var readAllStream = require('read-all-stream');
var timedOut = require('timed-out');
var urlParseLax = require('url-parse-lax');
var lowercaseKeys = require('lowercase-keys');
var isRedirect = require('is-redirect');
var PinkiePromise = require('pinkie-promise');
var unzipResponse = require('unzip-response');
var createErrorClass = require('create-error-class');
var nodeStatusCodes = require('node-status-codes');
var isPlainObj = require('is-plain-obj');
var parseJson = require('parse-json');

function backoff(iter) {
	var noise = Math.random() * 1000;
	return (1 << iter) * 1000 + noise;
}

function requestAsEventEmitter(opts) {
	opts = opts || {};

	var ee = new EventEmitter();
	var redirectCount = 0;
	var retryCount = 0;

	var get = function (opts) {
		var fn = opts.protocol === 'https:' ? https : http;

		var req = fn.request(opts, function (res) {
			var statusCode = res.statusCode;

			if (isRedirect(statusCode) && 'location' in res.headers && (opts.method === 'GET' || opts.method === 'HEAD')) {
				res.resume();

				if (++redirectCount > 10) {
					ee.emit('error', new got.MaxRedirectsError(statusCode, opts), null, res);
					return;
				}

				var redirectUrl = urlLib.resolve(urlLib.format(opts), res.headers.location);
				var redirectOpts = objectAssign({}, opts, urlLib.parse(redirectUrl));

				ee.emit('redirect', res, redirectOpts);

				get(redirectOpts);
				return;
			}

			// do not write ee.bind(...) instead of function - it will break gzip in Node.js 0.10
			setImmediate(function () {
				ee.emit('response', typeof unzipResponse === 'function' ? unzipResponse(res) : res);
			});
		});

		// this method is not documented, prints a warning if used while
		// not available
		if (!req.removeHeader) {
			req.removeHeader = function (headerName) {
				console.error('could not remove', headerName, 'header');
			};
		}

		// provide the ability to explicitly not send a header by setting
		// it to `null`
		var headerName;
		for (headerName in opts.headers) {
			if (opts.headers[headerName] === null) {
				req.removeHeader(headerName);
			}
		}

		req.once('error', function (err) {
			if (retryCount < opts.retries) {
				setTimeout(get, backoff(retryCount++), opts);
				return;
			}

			ee.emit('error', new got.RequestError(err, opts));
		});

		if (opts.timeout) {
			timedOut(req, opts.timeout);
		}

		setImmediate(ee.emit.bind(ee), 'request', req);
	};

	get(opts);
	return ee;
}

function asCallback(opts, cb) {
	var ee = requestAsEventEmitter(opts);

	ee.on('request', function (req) {
		if (isStream(opts.body)) {
			opts.body.pipe(req);
			opts.body = undefined;
			return;
		}

		req.end(opts.body);
	});

	ee.on('response', function (res) {
		readAllStream(res, opts.encoding, function (err, data) {
			var statusCode = res.statusCode;

			if (err) {
				cb(new got.ReadError(err, opts), null, res);
				return;
			}

			if (statusCode < 200 || statusCode > 299) {
				err = new got.HTTPError(statusCode, opts);
			}

			if (opts.json && statusCode !== 204) {
				try {
					data = parseJson(data);
				} catch (e) {
					e.fileName = urlLib.format(opts);
					err = new got.ParseError(e, opts);
				}
			}

			cb(err, data, res);
		});
	});

	ee.on('error', cb);
}

function asPromise(opts) {
	return new PinkiePromise(function (resolve, reject) {
		asCallback(opts, function (err, data, response) {
			if (response) {
				response.body = data;
			}

			if (err) {
				err.response = response;
				reject(err);
				return;
			}

			resolve(response);
		});
	});
}

function asStream(opts) {
	var proxy = duplexify();

	if (opts.json) {
		throw new Error('got can not be used as stream when options.json is used');
	}

	if (opts.body) {
		proxy.write = function () {
			throw new Error('got\'s stream is not writable when options.body is used');
		};
	}

	var ee = requestAsEventEmitter(opts);

	ee.on('request', function (req) {
		proxy.emit('request', req);

		if (isStream.readable(opts.body)) {
			opts.body.pipe(req);
			return;
		}

		if (opts.body) {
			req.end(opts.body);
			return;
		}

		if (opts.method === 'POST' || opts.method === 'PUT' || opts.method === 'PATCH') {
			proxy.setWritable(req);
			return;
		}

		req.end();
	});

	ee.on('response', function (res) {
		var statusCode = res.statusCode;

		proxy.setReadable(res);

		if (statusCode < 200 || statusCode > 299) {
			proxy.emit('error', new got.HTTPError(statusCode, opts), null, res);
			return;
		}

		proxy.emit('response', res);
	});

	ee.on('redirect', proxy.emit.bind(proxy, 'redirect'));

	ee.on('error', proxy.emit.bind(proxy, 'error'));

	return proxy;
}

function normalizeArguments(url, opts) {
	if (typeof url !== 'string' && typeof url !== 'object') {
		throw new Error('Parameter `url` must be a string or object, not ' + typeof url);
	}

	if (typeof url === 'string') {
		url = urlParseLax(url);

		if (url.auth) {
			throw new Error('Basic authentication must be done with auth option');
		}
	}

	opts = objectAssign(
		{protocol: 'http:', path: '', retries: 5},
		url,
		opts
	);

	opts.headers = objectAssign({
		'user-agent': 'https://github.com/sindresorhus/got',
		'accept-encoding': 'gzip,deflate'
	}, lowercaseKeys(opts.headers));

	var query = opts.query;

	if (query) {
		if (typeof query !== 'string') {
			opts.query = querystring.stringify(query);
		}

		opts.path = opts.path.split('?')[0] + '?' + opts.query;
		delete opts.query;
	}

	if (opts.json && opts.headers.accept === undefined) {
		opts.headers.accept = 'application/json';
	}

	var body = opts.body;

	if (body) {
		if (typeof body !== 'string' && !Buffer.isBuffer(body) && !isStream.readable(body) && !isPlainObj(body)) {
			throw new Error('options.body must be a ReadableStream, string, Buffer or plain Object');
		}

		opts.method = opts.method || 'POST';

		if (isPlainObj(body)) {
			if (opts.headers['content-type'] === undefined) {
				opts.headers['content-type'] = 'application/x-www-form-urlencoded';
			}
			body = opts.body = querystring.stringify(body);
		}

		if (opts.headers['content-length'] === undefined && !opts.headers['transfer-encoding'] && !isStream.readable(body)) {
			var length = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
			opts.headers['content-length'] = length;
		}
	}

	opts.method = opts.method || 'GET';

	if (opts.hostname === 'unix') {
		var matches = /(.+)\:(.+)/.exec(opts.path);

		if (matches) {
			opts.socketPath = matches[1];
			opts.path = matches[2];
			opts.host = null;
		}
	}

	return opts;
}

function got(url, opts, cb) {
	if (typeof opts === 'function') {
		cb = opts;
		opts = {};
	}

	if (cb) {
		asCallback(normalizeArguments(url, opts), cb);
		return null;
	}

	try {
		return asPromise(normalizeArguments(url, opts));
	} catch (error) {
		return PinkiePromise.reject(error);
	}
}

var helpers = [
	'get',
	'post',
	'put',
	'patch',
	'head',
	'delete'
];

helpers.forEach(function (el) {
	got[el] = function (url, opts, cb) {
		if (typeof opts === 'function') {
			cb = opts;
			opts = {};
		}

		return got(url, objectAssign({}, opts, {method: el.toUpperCase()}), cb);
	};
});

got.stream = function (url, opts, cb) {
	if (cb || typeof opts === 'function') {
		throw new Error('callback can not be used with stream mode');
	}

	return asStream(normalizeArguments(url, opts));
};

helpers.forEach(function (el) {
	got.stream[el] = function (url, opts) {
		return got.stream(url, objectAssign({}, opts, {method: el.toUpperCase()}));
	};
});

function stdError(error, opts) {
	objectAssign(this, {
		message: error.message,
		code: error.code,
		host: opts.host,
		hostname: opts.hostname,
		method: opts.method,
		path: opts.path
	});
}

got.RequestError = createErrorClass('RequestError', stdError);
got.ReadError = createErrorClass('ReadError', stdError);
got.ParseError = createErrorClass('ParseError', stdError);

got.HTTPError = createErrorClass('HTTPError', function (statusCode, opts) {
	stdError.call(this, {}, opts);
	this.statusCode = statusCode;
	this.statusMessage = nodeStatusCodes[this.statusCode];
	this.message = 'Response code ' + this.statusCode + ' (' + this.statusMessage + ')';
});

got.MaxRedirectsError = createErrorClass('MaxRedirectsError', function (statusCode, opts) {
	stdError.call(this, {}, opts);
	this.statusCode = statusCode;
	this.statusMessage = nodeStatusCodes[this.statusCode];
	this.message = 'Redirected 10 times. Aborting.';
});

module.exports = got;
