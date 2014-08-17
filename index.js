'use strict';
var urlLib = require('url');
var http = require('http');
var https = require('https');
var zlib = require('zlib');
var assign = require('object-assign');

module.exports = function (url, opts, cb) {
	var redirectCount = 0;

	// Extract got options.
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
			var n = 0;

			res.on('data', function (chunk) {
				// Add the new chunk to the list.
				chunks.push(chunk);
				n += chunk.length;
			});

			res.once('end', function () {
				// Concatenate all chunks into a single buffer.
				var data = Buffer.concat(chunks, n);

				// Unless the encoding has been explicitely set to `null`,
				// convert the buffer to a string.
				if (encoding !== null) {
					data = data.toString(encoding || 'utf8');
				}

				// Return the result.
				cb(null, data, res);
			});
		}).once('error', cb);
	};

	get(url, opts, cb);
};
