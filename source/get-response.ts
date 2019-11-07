import {IncomingMessage} from 'http';
import EventEmitter = require('events');
import stream = require('stream');
import is from '@sindresorhus/is';
import decompressResponse = require('decompress-response');
import mimicResponse = require('mimic-response');
import {NormalizedOptions, Response} from './utils/types';
import {downloadProgress} from './progress';

export default (response: IncomingMessage, options: NormalizedOptions, emitter: EventEmitter) => {
	const downloadBodySize = Number(response.headers['content-length']) || undefined;
	const progressStream = downloadProgress(response, emitter, downloadBodySize);

	mimicResponse(response, progressStream);

	const newResponse = (
		options.decompress === true &&
		is.function_(decompressResponse) &&
		options.method !== 'HEAD' ? decompressResponse(progressStream as unknown as IncomingMessage) : progressStream
	) as Response;

	if (!options.decompress && ['gzip', 'deflate', 'br'].includes(response.headers['content-encoding'] ?? '')) {
		options.encoding = null;
	}

	emitter.emit('response', newResponse);

	emitter.emit('downloadProgress', {
		percent: 0,
		transferred: 0,
		total: downloadBodySize
	});

	stream.pipeline(
		response,
		progressStream,
		error => {
			if (error) {
				emitter.emit('error', error);
			}
		}
	);
};
