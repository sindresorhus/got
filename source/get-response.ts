import decompressResponse = require('decompress-response');
import EventEmitter = require('events');
import mimicResponse = require('mimic-response');
import stream = require('stream');
import {IncomingMessage} from 'http';
import {downloadProgress} from './progress';
import {NormalizedOptions} from './utils/types';

export default (response: IncomingMessage, options: NormalizedOptions, emitter: EventEmitter) => {
	const downloadBodySize = Number(response.headers['content-length']) || undefined;
	const progressStream = downloadProgress(emitter, downloadBodySize);

	mimicResponse(response, progressStream);

	const newResponse = (
		options.decompress &&
		options.method !== 'HEAD' ? decompressResponse(progressStream as unknown as IncomingMessage) : progressStream
	);

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
