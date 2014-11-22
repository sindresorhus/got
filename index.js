'use strict';
var http = require('http');
var https = require('https');
var urlLib = require('url');
var zlib = require('zlib');
var PassThrough = require('stream').PassThrough;
var assign = require('object-assign');
var read = require('read-all-stream');
var timeout = require('timed-out');

module.exports = function (url, opts, cb) {
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

	// returns a proxy stream to the response
	// if no callback has been provided
	var proxy;
	if (!cb) {
		proxy = new PassThrough();

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
		var parsedUrl = urlLib.parse(url);
		var fn = parsedUrl.protocol === 'https:' ? https : http;
		var arg = assign({}, parsedUrl, opts);

		var req = fn.get(arg, function (response) {
			var statusCode = response.statusCode;
			var res = response;

			// redirect
			if (statusCode < 400 && statusCode >= 300 && res.headers.location) {
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
				res.on('error', proxy.emit.bind(proxy, 'error')).pipe(proxy);
				return;
			}

			read(res, encoding, cb, response);
		}).once('error', cb);

		if (opts.timeout) {
			timeout(req, opts.timeout);
		}
	};

	get(url, opts, cb);

	return proxy;
};
