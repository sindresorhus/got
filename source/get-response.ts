import {IncomingMessage} from 'http';
import EventEmitter from 'events';
import {Transform as TransformStream} from 'stream';
import is from '@sindresorhus/is';
import {Options, Response} from './utils/types';
import {download} from './progress';

const decompressResponse = require('decompress-response');
const mimicResponse = require('mimic-response');

export default (response: IncomingMessage, options: Options, emitter: EventEmitter) => {
	const downloadBodySize = Number(response.headers['content-length']) || undefined;

	const progressStream: TransformStream = download(response, emitter, downloadBodySize);

	mimicResponse(response, progressStream);

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
