import EventEmitter = require('events');
import {Transform as TransformStream} from 'stream';
import is from '@sindresorhus/is';

export function createProgressStream(name: 'downloadProgress' | 'uploadProgress', emitter: EventEmitter, totalBytes?: number | string): TransformStream {
	let transformedBytes = 0;

	if (is.string(totalBytes)) {
		totalBytes = Number(totalBytes);
	}

	const progressStream = new TransformStream({
		transform(chunk, _encoding, callback) {
			transformedBytes += chunk.length;

			const percent = totalBytes ? transformedBytes / (totalBytes as number) : 0;

			// Let `flush()` be responsible for emitting the last event
			if (percent < 1) {
				emitter.emit(name, {
					percent,
					transferred: transformedBytes,
					total: totalBytes
				});
			}

			callback(undefined, chunk);
		},

		flush(callback) {
			emitter.emit(name, {
				percent: 1,
				transferred: transformedBytes,
				total: totalBytes
			});

			callback();
		}
	});

	emitter.emit(name, {
		percent: 0,
		transferred: 0,
		total: totalBytes
	});

	return progressStream;
}
