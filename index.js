'use strict';

var http = require('http');
var https = require('https');
var urlLib = require('url');
var zlib = require('zlib');
var PassThrough = require('stream').PassThrough;

var assign = require('object-assign');

module.exports = function (url, opts, cb) {
	if (typeof opts === 'function') {
		// If `cb` has been specified but `opts` has not.
		cb = opts;
		opts = {};
	} else if (!opts) {
		// opts has not been specified.
		opts = {};
	}

	// extract own options
	var encoding = opts.encoding;
	delete opts.encoding;

	// If no callback has been provided, returns a proxy stream to the
	// response.
	var proxy;
	if (!cb) {
		proxy = new PassThrough();

		// Forward errors on the stream.
		cb = function (err) {
			proxy.emit('error', err);
		};
	}

	// Merge additional headers.
	opts.headers = assign({
		'user-agent': 'https://github.com/sindresorhus/got',
		'accept-encoding': 'gzip,deflate'
	}, opts.headers || {});

	var redirectCount = 0;
	var get = function (url, opts, cb) {
		var parsedUrl = urlLib.parse(url);
		var fn = parsedUrl.protocol === 'https:' ? https : http;
		var arg = assign({}, parsedUrl, opts);

		fn.get(arg, function (res) {
			// redirect
			if (res.statusCode < 400 && res.statusCode >= 300 && res.headers.location) {
				res.destroy();

				if (++redirectCount > 10) {
					cb(new Error('Redirected 10 times. Aborting.'));
					return;
				}

				get(urlLib.resolve(url, res.headers.location), opts, cb);
				return;
			}

			if (res.statusCode < 200 || res.statusCode > 299) {
				res.destroy();
				cb(res.statusCode);
				return;
			}

			if (['gzip', 'deflate'].indexOf(res.headers['content-encoding']) !== -1) {
				var unzip = zlib.createUnzip();
				res.pipe(unzip);
				res = unzip;
			}

			// If in proxy mode, simply pipe the response to the proxy.
			if (proxy) {
				res.pipe(proxy);
				return;
			}

			res.once('error', cb);

			var chunks = [];
			var len = 0;

			res.on('data', function (chunk) {
				chunks.push(chunk);
				len += chunk.length;
			});

			res.once('end', function () {
				var data = Buffer.concat(chunks, len);

				if (encoding !== null) {
					data = data.toString(encoding || 'utf8');
				}

				cb(null, data, res);
			});
		}).once('error', cb);
	};

	get(url, opts, cb);
	return proxy;
};
