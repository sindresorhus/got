import {IncomingMessage} from 'http';
import EventEmitter from 'events';
import {Transform, PassThrough} from 'stream';
import is from '@sindresorhus/is';
import {download} from './progress';

const decompressResponse = require('decompress-response');
const mimicResponse = require('mimic-response');

/**
 * @todo use the Got options-object types.
 */
interface Options {
	decompress: boolean;
	encoding: BufferEncoding | null;
	method: string;
}

export default (response: IncomingMessage, options: Options, emitter: EventEmitter) => {
	const downloadBodySize = Number(response.headers['content-length']) || undefined;

	const progressStream: Transform = download(response, emitter, downloadBodySize);

	mimicResponse(response, progressStream);

	const newResponse: PassThrough | Transform = options.decompress === true &&
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
