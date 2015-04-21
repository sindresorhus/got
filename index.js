'use strict';
var http = require('http');
var https = require('https');
var urlLib = require('url');
var util = require('util');
var zlib = require('zlib');
var objectAssign = require('object-assign');
var infinityAgent = require('infinity-agent');
var duplexify = require('duplexify');
var isStream = require('is-stream');
var readAllStream = require('read-all-stream');
var timedOut = require('timed-out');
var prependHttp = require('prepend-http');
var lowercaseKeys = require('lowercase-keys');
var statuses = require('statuses');
var NestedErrorStacks = require('nested-error-stacks');

function GotError(message, nested) {
	NestedErrorStacks.call(this, message, nested);
	objectAssign(this, nested, {nested: this.nested});
}

util.inherits(GotError, NestedErrorStacks);
GotError.prototype.name = 'GotError';

function got(url, opts, cb) {
	if (typeof opts === 'function') {
		cb = opts;
		opts = {};
	} else if (!opts) {
		opts = {};
	}

	opts = objectAssign({}, opts);

	opts.headers = objectAssign({
		'user-agent': 'https://github.com/sindresorhus/got',
		'accept-encoding': 'gzip,deflate'
	}, lowercaseKeys(opts.headers));

	var encoding = opts.encoding;
	var body = opts.body;
	var json = opts.json;
	var proxy;
	var redirectCount = 0;

	delete opts.encoding;
	delete opts.body;
	delete opts.json;

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

	if (proxy && json) {
		throw new GotError('got can not be used as stream when options.json is used');
	}

	function get(url, opts, cb) {
		var parsedUrl = urlLib.parse(prependHttp(url));
		var fn = parsedUrl.protocol === 'https:' ? https : http;
		var arg = objectAssign({}, parsedUrl, opts);

		if (arg.agent === undefined) {
			arg.agent = infinityAgent[fn === https ? 'https' : 'http'].globalAgent;

			// TODO: remove this when Node 0.10 will be deprecated
			if (process.version.indexOf('v0.10') === 0 && fn === https && (
				typeof opts.ca !== 'undefined' ||
				typeof opts.cert !== 'undefined' ||
				typeof opts.ciphers !== 'undefined' ||
				typeof opts.key !== 'undefined' ||
				typeof opts.passphrase !== 'undefined' ||
				typeof opts.pfx !== 'undefined' ||
				typeof opts.rejectUnauthorized !== 'undefined')) {
				arg.agent = new (infinityAgent.https.Agent)(opts);
			}
		}

		var req = fn.request(arg, function (response) {
			var statusCode = response.statusCode;
			var res = response;

			if (proxy) {
				proxy.emit('response', res);
			}

			// redirect
			if (statuses.redirect[statusCode] && 'location' in res.headers) {
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
				readAllStream(res, encoding, function (err, data) {
					err = new GotError(url + ' response code is ' + statusCode + ' (' + statuses[statusCode] + ')', err);
					err.code = statusCode;

					if (data && json) {
						try {
							data = JSON.parse(data);
						} catch (e) {
							err = new GotError('Parsing ' + url + ' response failed', new GotError(e.message, err));
						}
					}

					cb(err, data, response);
				});
				return;
			}

			// pipe the response to the proxy if in proxy mode
			if (proxy) {
				proxy.setReadable(res);
				return;
			}

			readAllStream(res, encoding, function (err, data) {
				if (err) {
					err = new GotError('Reading ' + url + ' response failed', err);
				} else if (json) {
					try {
						data = JSON.parse(data);
					} catch (e) {
						err = new GotError('Parsing ' + url + ' response failed', e);
					}
				}

				cb(err, data, response);
			});
		}).once('error', function (err) {
			cb(new GotError('Request to ' + url + ' failed', err));
		});

		if (opts.timeout) {
			timedOut(req, opts.timeout);
		}

		if (!proxy) {
			if (isStream.readable(body)) {
				body.pipe(req);
			} else {
				req.end(body);
			}

			return;
		}

		if (body) {
			proxy.write = function () {
				throw new Error('got\'s stream is not writable when options.body is used');
			};

			if (isStream.readable(body)) {
				body.pipe(req);
			} else {
				req.end(body);
			}

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
		if (typeof opts === 'function') {
			cb = opts;
			opts = undefined;
		}

		return got(url, objectAssign({}, opts, {method: el.toUpperCase()}), cb);
	};
});

module.exports = got;
