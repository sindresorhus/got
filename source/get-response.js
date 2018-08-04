'use strict';
const {Transform} = require('stream');
const decompressResponse = require('decompress-response');
const is = require('@sindresorhus/is');
const mimicResponse = require('mimic-response');

module.exports = (response, options, emitter, redirects) => {
	const downloadBodySize = Number(response.headers['content-length']) || null;
	let downloaded = 0;

	const progressStream = new Transform({
		transform(chunk, encoding, callback) {
			downloaded += chunk.length;

			const percent = downloadBodySize ? downloaded / downloadBodySize : 0;

			// Let `flush()` be responsible for emitting the last event
			if (percent < 1) {
				emitter.emit('downloadProgress', {
					percent,
					transferred: downloaded,
					total: downloadBodySize
				});
			}

			callback(null, chunk);
		},

		flush(callback) {
			emitter.emit('downloadProgress', {
				percent: 1,
				transferred: downloaded,
				total: downloadBodySize
			});

			callback();
		}
	});

	mimicResponse(response, progressStream);
	progressStream.redirectUrls = redirects;

	const newResponse = options.decompress === true &&
		is.function(decompressResponse) &&
		options.method !== 'HEAD' ? decompressResponse(progressStream) : progressStream;

	if (!options.decompress && ['gzip', 'deflate'].includes(response.headers['content-encoding'])) {
		options.encoding = null;
	}

	emitter.emit('response', newResponse);

	emitter.emit('downloadProgress', {
		percent: 0,
		transferred: 0,
		total: downloadBodySize
	});

	response.pipe(progressStream);
};
