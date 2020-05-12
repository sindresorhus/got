'use strict';
import {IncomingMessage} from 'http';
import {Transform, PassThrough} from 'stream';
import zlib = require('zlib');

const knownProperties = [
	'aborted',
	'complete',
	'headers',
	'httpVersion',
	'httpVersionMinor',
	'httpVersionMajor',
	'method',
	'rawHeaders',
	'rawTrailers',
	'setTimeout',
	'socket',
	'statusCode',
	'statusMessage',
	'trailers',
	'url'
];

// TODO: Switch back to the `decompress-response` package when it's fixed
const decompressResponse = (response: IncomingMessage): IncomingMessage => {
	const contentEncoding = (response.headers['content-encoding'] ?? '').toLowerCase();

	if (!['gzip', 'deflate', 'br'].includes(contentEncoding)) {
		return response;
	}

	// TODO: Remove this when targeting Node.js 12.
	const isBrotli = contentEncoding === 'br';
	if (isBrotli && typeof zlib.createBrotliDecompress !== 'function') {
		response.destroy(new Error('Brotli is not supported on Node.js < 12'));
		return response;
	}

	let isEmpty = true;

	const checker = new Transform({
		transform(data, _encoding, callback) {
			isEmpty = false;

			callback(null, data);
		},

		flush(callback) {
			callback();
		}
	});

	const stream = new PassThrough({
		autoDestroy: false,
		destroy(error, callback) {
			response.destroy();

			callback(error);
		}
	});

	const decompressStream = isBrotli ? zlib.createBrotliDecompress() : zlib.createUnzip();

	decompressStream.once('error', (error: Error) => {
		if (isEmpty) {
			stream.end();
			return;
		}

		stream.destroy(error);
	});

	response.pipe(checker).pipe(decompressStream).pipe(stream);

	response.once('error', error => {
		stream.destroy(error);
	});

	const properties: {[key: string]: any} = {};

	for (const property of knownProperties) {
		properties[property] = {
			get() {
				return (response as any)[property];
			},
			set(value: unknown) {
				(response as any)[property] = value;
			},
			enumerable: true,
			configurable: false
		};
	}

	Object.defineProperties(stream, properties);

	return stream as unknown as IncomingMessage;
};

export default decompressResponse;
