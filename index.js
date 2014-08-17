'use strict';
var urlLib = require('url');
var http = require('http');
var https = require('https');
var zlib = require('zlib');
var assign = require('object-assign');

module.exports = function (url, opts, cb) {
	var redirectCount = 0;

	// extract own options
	var encoding = opts.encoding;
	delete opts.encoding;

	var get = function (url, opts, cb) {
		if (typeof opts === 'function') {
			cb = opts;
			opts = {};
		}

		cb = cb || function () {};
		opts = opts || {};

		opts.headers = assign({
			'user-agent': 'https://github.com/sindresorhus/got',
			'accept-encoding': 'gzip,deflate'
		}, opts.headers || {});

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
};
