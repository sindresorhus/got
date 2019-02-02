import {IncomingMessage} from 'http';
import EventEmitter from 'events';
import {Transform} from 'stream';
import is from '@sindresorhus/is';
import {Options, Response} from './utils/types';
import {download} from './progress';

const decompressResponse = require('decompress-response');
const mimicResponse = require('mimic-response');

export default (response: IncomingMessage, options: Options, emitter: EventEmitter) => {
	const downloadBodySize = Number(response.headers['content-length']) || undefined;

	const progressStream: Transform = download(response, emitter, downloadBodySize);

	mimicResponse(response, progressStream);

	// @todo
	// I believe this typings was slightly wrong because the way `response` is used in 
	// `as-stream.ts::52` it requires a `statusCode` which `IncomingMessage` from node has.
	// Maybe a maintainer can guide me a bit here.
	const newResponse: Response = options.decompress === true &&
		is.function_(decompressResponse) &&
		options.method !== 'HEAD' ? decompressResponse(progressStream) : progressStream;

	if (!options.decompress && ['gzip', 'deflate', 'br'].includes(response.headers['content-encoding'] || '')) {
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
