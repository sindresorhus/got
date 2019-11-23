import {promisify} from 'util';
import {IncomingMessage} from 'http';
import EventEmitter = require('events');
import stream = require('stream');
import decompressResponse = require('decompress-response');
import mimicResponse = require('mimic-response');
import {NormalizedOptions, Response} from './utils/types';
import {createProgressStream} from './progress';

const pipeline = promisify(stream.pipeline);

export default async (response: IncomingMessage, options: NormalizedOptions, emitter: EventEmitter) => {
	const downloadBodySize = Number(response.headers['content-length']) || undefined;
	const progressStream = createProgressStream('downloadProgress', emitter, downloadBodySize);

	mimicResponse(response, progressStream);

	const newResponse = (
		options.decompress &&
		options.method !== 'HEAD' ? decompressResponse(progressStream as unknown as IncomingMessage) : progressStream
	) as Response;

	if (!options.decompress && ['gzip', 'deflate', 'br'].includes(response.headers['content-encoding'] ?? '')) {
		options.responseType = 'default';

		// @ts-ignore Internal use.
		options.encoding = 'buffer';
	}

	emitter.emit('response', newResponse);

	return pipeline(
		response,
		progressStream
	);
};
