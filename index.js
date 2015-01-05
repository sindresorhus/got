'use strict';
var http = require('http');
var https = require('https');
var urlLib = require('url');
var zlib = require('zlib');
var assign = require('object-assign');
var agent = require('infinity-agent');
var duplexify = require('duplexify');
var isReadableStream = require('isstream').isReadable;
var read = require('read-all-stream');
var timeout = require('timed-out');
var prependHttp = require('prepend-http');

function got(url, opts, cb) {
	if (typeof opts === 'function') {
		// if `cb` has been specified but `opts` has not
		cb = opts;
		opts = {};
	} else if (!opts) {
		// opts has not been specified
		opts = {};
	}

	// extract own options
	var encoding = opts.encoding;
	delete opts.encoding;

	var body = opts.body;
	delete opts.body;

	if (body) {
		opts.method = opts.method || 'POST';
	}

	// returns a proxy stream to the response
	// if no callback has been provided
	var proxy;
	if (!cb) {
		proxy = duplexify();

		// forward errors on the stream
		cb = function (err) {
			proxy.emit('error', err);
		};
	}

	// merge additional headers
	opts.headers = assign({
		'user-agent': 'https://github.com/sindresorhus/got',
		'accept-encoding': 'gzip,deflate'
	}, opts.headers || {});

	var redirectCount = 0;

	var get = function (url, opts, cb) {
		var parsedUrl = urlLib.parse(prependHttp(url));
		var fn = parsedUrl.protocol === 'https:' ? https : http;
		var arg = assign({}, parsedUrl, opts);

		// TODO: remove this when Node 0.10 will be deprecated
		if (arg.agent === undefined) {
			arg.agent = agent(arg);
		}

		var req = fn.request(arg, function (response) {
			var statusCode = response.statusCode;
			var res = response;

			// redirect
			if (statusCode >= 300 && statusCode < 400 && 'location' in res.headers) {
				res.resume(); // Discard response

				if (++redirectCount > 10) {
					cb(new Error('Redirected 10 times. Aborting.'), undefined, res);
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
				read(res, encoding, function (error, data) {
					var err = error || new Error('Couldn\'t connect to ' + url + '.');
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

			read(res, encoding, cb, response);
		}).once('error', cb);

		if (opts.timeout) {
			timeout(req, opts.timeout);
		}

		if (!proxy) {
			isReadableStream(body) ? body.pipe(req) : req.end(body);
			return;
		}

		if (body) {
			proxy.write = function () {
				throw new Error('got\'s stream is not writable when options.body is used');
			};

			isReadableStream(body) ? body.pipe(req) : req.end(body);
			return;
		}

		if (opts.method === 'POST' || opts.method === 'PUT' || opts.method === 'PATCH') {
			proxy.setWritable(req);
			return;
		}

		req.end();
	};

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
