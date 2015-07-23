'use strict';
var EventEmitter = require('events').EventEmitter;
var http = require('http');
var https = require('https');
var urlLib = require('url');
var util = require('util');
var querystring = require('querystring');
var objectAssign = require('object-assign');
var duplexify = require('duplexify');
var isStream = require('is-stream');
var readAllStream = require('read-all-stream');
var timedOut = require('timed-out');
var prependHttp = require('prepend-http');
var lowercaseKeys = require('lowercase-keys');
var isRedirect = require('is-redirect');
var NestedErrorStacks = require('nested-error-stacks');
var pinkiePromise = require('pinkie-promise');
var unzipResponse = require('unzip-response');

function GotError(message, nested) {
	NestedErrorStacks.call(this, message, nested);
	objectAssign(this, nested, {nested: this.nested});
}

util.inherits(GotError, NestedErrorStacks);
GotError.prototype.name = 'GotError';

function requestAsEventEmitter(opts) {
	opts = opts || {};

	var ee = new EventEmitter();
	var redirectCount = 0;

	var get = function (opts) {
		var fn = opts.protocol === 'https:' ? https : http;
		var url = urlLib.format(opts);

		var req = fn.request(opts, function (res) {
			var statusCode = res.statusCode;
			if (isRedirect(statusCode) && 'location' in res.headers && (opts.method === 'GET' || opts.method === 'HEAD')) {
				res.resume();

				if (++redirectCount > 10) {
					ee.emit('error', new GotError('Redirected 10 times. Aborting.'), undefined, res);
					return;
				}

				var redirectUrl = urlLib.resolve(url, res.headers.location);
				var redirectOpts = objectAssign({}, opts, urlLib.parse(redirectUrl));

				ee.emit('redirect', res, redirectOpts);

				get(redirectOpts);
				return;
			}

			ee.emit('response', unzipResponse(res));
		}).once('error', function (err) {
			ee.emit('error', new GotError('Request to ' + url + ' failed', err));
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
	var url = urlLib.format(opts);

	ee.on('request', function (req) {
		if (isStream.readable(opts.body)) {
			opts.body.pipe(req);
			opts.body = undefined;
			return;
		}

		req.end(opts.body);
	});

	ee.on('response', function (res) {
		readAllStream(res, opts.encoding, function (err, data) {
			if (err) {
				cb(new GotError('Reading ' + url + ' response failed', err), null, res);
				return;
			}

			var statusCode = res.statusCode;

			if (statusCode < 200 || statusCode > 299) {
				err = new GotError(opts.method + ' ' + url + ' response code is ' + statusCode + ' (' + http.STATUS_CODES[statusCode] + ')', err);
				err.code = statusCode;
			}

			if (opts.json && statusCode !== 204) {
				try {
					data = JSON.parse(data);
				} catch (e) {
					err = new GotError('Parsing ' + url + ' response failed', new GotError(e.message, err));
				}
			}

			cb(err, data, res);
		});
	});

	ee.on('error', cb);
}

function asPromise(opts) {
	var promise = new pinkiePromise(function (resolve, reject) {
		asCallback(opts, function (err, data, response) {
			response.body = data;

			if (err) {
				err.response = response;
				reject(err);
				return;
			}

			resolve(response);
		});
	});

	return promise;
}

function asStream(opts) {
	var proxy = duplexify();

	if (opts.json) {
		throw new GotError('got can not be used as stream when options.json is used');
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
		proxy.setReadable(res);
		proxy.emit('response', res);
	});

	ee.on('redirect', proxy.emit.bind(proxy, 'redirect'));

	return proxy;
}

function normalizeArguments(url, opts) {
	if (typeof url !== 'string' && typeof url !== 'object') {
		throw new GotError('Parameter `url` must be a string or object, not ' + typeof url);
	}

	opts = objectAssign(
		{protocol: 'http:'},
		typeof url === 'string' ? urlLib.parse(prependHttp(url)) : url,
		opts
	);

	opts.headers = objectAssign({
		'user-agent': 'https://github.com/sindresorhus/got',
		'accept-encoding': 'gzip,deflate'
	}, lowercaseKeys(opts.headers));

	if (opts.pathname) {
		opts.path = opts.pathname;
	}

	var query = opts.query;
	if (query) {
		if (typeof query !== 'string') {
			opts.query = querystring.stringify(query);
		}

		opts.path = opts.pathname + '?' + opts.query;
		delete opts.query;
	}

	if (opts.json) {
		opts.headers.accept = opts.headers.accept || 'application/json';
	}

	var body = opts.body;
	if (body) {
		if (typeof body !== 'string' && !Buffer.isBuffer(body) && !isStream.readable(body)) {
			throw new GotError('options.body must be a ReadableStream, string or Buffer');
		}

		opts.method = opts.method || 'POST';

		if (!opts.headers['content-length'] && !opts.headers['transfer-encoding'] && !isStream.readable(body)) {
			var length = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
			opts.headers['content-length'] = length;
		}
	}

	opts.method = opts.method || 'GET';

	return opts;
}

function got(url, opts, cb) {
	if (typeof opts === 'function') {
		cb = opts;
		opts = {};
	}

	opts = normalizeArguments(url, opts);

	if (cb) {
		asCallback(opts, cb);
		return;
	}

	return asPromise(opts);
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

got.stream = function (url, opts) {
	return asStream(normalizeArguments(url, opts));
};

helpers.forEach(function (el) {
	got.stream[el] = function (url, opts) {
		return got.stream(url, objectAssign({}, opts, {method: el.toUpperCase()}));
	};
});

module.exports = got;
