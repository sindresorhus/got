import decompressResponse = require('decompress-response');
import EventEmitter = require('events');
import mimicResponse = require('mimic-response');
import stream = require('stream');
import {IncomingMessage} from 'http';
import {promisify} from 'util';
import {createProgressStream} from './progress';
import {NormalizedOptions} from './types';

const pipeline = promisify(stream.pipeline);

export default async (response: IncomingMessage, options: NormalizedOptions, emitter: EventEmitter): Promise<void> => {
	const downloadBodySize = Number(response.headers['content-length']) || undefined;
	const progressStream = createProgressStream('downloadProgress', emitter, downloadBodySize);

	mimicResponse(response, progressStream);

	const newResponse = (
		options.decompress &&
		options.method !== 'HEAD' ? decompressResponse(progressStream as unknown as IncomingMessage) : progressStream
	) as IncomingMessage;

	if (!options.decompress && ['gzip', 'deflate', 'br'].includes(newResponse.headers['content-encoding'] ?? '')) {
		options.responseType = 'buffer';
	}

	emitter.emit('response', newResponse);

	return pipeline(
		response,
		progressStream
	).catch(error => {
		if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
			throw error;
		}
	});
};
