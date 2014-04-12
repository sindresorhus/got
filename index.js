'use strict';
var urlLib = require('url');
var http = require('http');
var https = require('https');

module.exports = function (url, cb) {
	var redirectCount = 0;

	var get = function (url, cb) {
		var fn = urlLib.parse(url).protocol === 'https:' ? https : http;

		fn.get(url, function (res) {
			var ret = '';

			// redirect
			if (res.statusCode < 400 && res.statusCode >= 300 && res.headers.location) {
				res.destroy();

				if (++redirectCount > 10) {
					cb(new Error('Redirected 10 times. Aborting.'));
					return;
				}

				get(urlLib.resolve(url, res.headers.location), cb);
				return;
			}

			if (res.statusCode !== 200) {
				res.destroy();
				cb(res.statusCode);
				return;
			}

			res.setEncoding('utf8');

			res.on('data', function (data) {
				ret += data;
			});

			res.on('end', function () {
				cb(null, ret);
			});
		}).on('error', cb);
	};

	get(url, cb);
};
