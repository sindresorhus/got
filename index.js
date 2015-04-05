'use strict';
var http = require('http');
var https = require('https');
var urlLib = require('url');
var util = require('util');
var zlib = require('zlib');
var objectAssign = require('object-assign');
var agent = require('infinity-agent');
var duplexify = require('duplexify');
var isStream = require('is-stream');
var read = require('read-all-stream');
var timeout = require('timed-out');
var prependHttp = require('prepend-http');
var lowercaseKeys = require('lowercase-keys');
var status = require('statuses');
var NestedError = require('nested-error-stacks');

function GotError(message, nested) {
	NestedError.call(this, message, nested);
	objectAssign(this, nested);
}

util.inherits(GotError, NestedError);
GotError.prototype.name = 'GotError';

function isSendable(body) {
	return Buffer.isBuffer(body) || typeof body === 'string' || body instanceof String;
}

function got(url, opts, cb) {
	if (typeof opts === 'function') {
		cb = opts;
		opts = {};
	} else if (!opts) {
		opts = {};
	}

	opts = objectAssign({}, opts);

	var defaultHeaders = {
		'user-agent': 'https://github.com/sindresorhus/got',
		'accept-encoding': 'gzip,deflate'
	};

	if (!isSendable(opts.body)) {
		defaultHeaders['content-type'] = 'application/json';
	}

	opts.headers = objectAssign(defaultHeaders, lowercaseKeys(opts.headers));

	var encoding = opts.encoding;
	var body = opts.body;
	var proxy;
	var redirectCount = 0;

	delete opts.encoding;
	delete opts.body;

	if (body) {
		opts.method = opts.method || 'POST';
	}

	// returns a proxy stream to the response
	// if no callback has been provided
	if (!cb) {
		proxy = duplexify();

		// forward errors on the stream
		cb = function (err) {
			proxy.emit('error', err);
		};
	}

	function get(url, opts, cb) {
		var parsedUrl = urlLib.parse(prependHttp(url));
		var fn = parsedUrl.protocol === 'https:' ? https : http;
		var arg = objectAssign({}, parsedUrl, opts);

		// TODO: remove this when Node 0.10 will be deprecated
		if (arg.agent === undefined) {
			arg.agent = agent(arg);
		}

		var req = fn.request(arg, function (response) {
			var statusCode = response.statusCode;
			var res = response;

			if (proxy) {
				proxy.emit('response', res);
			}

			// redirect
			if (status.redirect[statusCode] && 'location' in res.headers) {
				res.resume(); // Discard response

				if (++redirectCount > 10) {
					cb(new GotError('Redirected 10 times. Aborting.'), undefined, res);
					return;
				}

				get(urlLib.resolve(url, res.headers.location), opts, cb);
				return;
			}

			if (['gzip', 'deflate'].indexOf(res.headers['content-encoding']) !== -1) {
				var unzip = zlib.createUnzip();
				res.pipe(unzip);
				res = unzip;
			}

			if (statusCode < 200 || statusCode > 299) {
				read(res, encoding, function (err, data) {
					err = new GotError(url + ' response code is ' + statusCode + ' (' + status[statusCode] + ')', err);
					err.code = statusCode;
					cb(err, data, response);
				});
				return;
			}

			// pipe the response to the proxy if in proxy mode
			if (proxy) {
				proxy.setReadable(res);
				return;
			}

			read(res, encoding, function (err, data) {
				if (err) {
					err = new GotError('Reading ' + url + ' response failed', err);
				}

				cb(err, data, response);
			});
		}).once('error', function (err) {
			cb(new GotError('Request to ' + url + ' failed', err));
		});

		if (opts.timeout) {
			timeout(req, opts.timeout);
		}

		function send(req, body) {
			if (isStream.readable(body)) {
				body.pipe(req);
			} else if (isSendable(body)) {
				req.end(body);
			} else if (body) {
				req.end(JSON.stringify(body));
			} else {
				req.end();
			}
		}

		if (!proxy) {
			send(req, body);
			return;
		}

		if (body) {
			proxy.write = function () {
				throw new Error('got\'s stream is not writable when options.body is used');
			};

			send(req, body);
			return;
		}

		if (opts.method === 'POST' || opts.method === 'PUT' || opts.method === 'PATCH') {
			proxy.setWritable(req);
			return;
		}

		req.end();
	}

	get(url, opts, cb);
	return proxy;
}

[
	'get',
	'post',
	'put',
	'patch',
	'head',
	'delete'
].forEach(function (el) {
	got[el] = function (url, opts, cb) {
		opts = opts || {};
		opts.method = el.toUpperCase();
		return got(url, opts, cb);
	};
});

module.exports = got;
