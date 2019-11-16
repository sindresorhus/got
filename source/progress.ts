import {ClientRequest} from 'http';
import {Transform as TransformStream} from 'stream';
import {Socket} from 'net';
import EventEmitter = require('events');
import is from '@sindresorhus/is';

export function downloadProgress(emitter: EventEmitter, downloadBodySize?: number): TransformStream {
	let downloadedBytes = 0;

	const progressStream = new TransformStream({
		transform(chunk, _encoding, callback) {
			downloadedBytes += chunk.length;

			const percent = downloadBodySize ? downloadedBytes / downloadBodySize : 0;

			// Let `flush()` be responsible for emitting the last event
			if (percent < 1) {
				emitter.emit('downloadProgress', {
					percent,
					transferred: downloadedBytes,
					total: downloadBodySize
				});
			}

			callback(undefined, chunk);
		},

		flush(callback) {
			emitter.emit('downloadProgress', {
				percent: 1,
				transferred: downloadedBytes,
				total: downloadBodySize
			});

			callback();
		}
	});

	return progressStream;
}

export function uploadProgress(request: ClientRequest, emitter: EventEmitter, uploadBodySize?: number): void {
	const uploadEventFrequency = 150;
	let uploadedBytes = 0;
	let progressInterval: NodeJS.Timeout;

	emitter.emit('uploadProgress', {
		percent: 0,
		transferred: 0,
		total: uploadBodySize
	});

	request.once('error', () => {
		clearInterval(progressInterval);
	});

	request.once('abort', () => {
		clearInterval(progressInterval);
	});

	request.once('response', () => {
		clearInterval(progressInterval);

		emitter.emit('uploadProgress', {
			percent: 1,
			transferred: uploadedBytes,
			total: uploadBodySize
		});
	});

	request.once('socket', (socket: Socket) => {
		const onSocketConnect = (): void => {
			progressInterval = setInterval(() => {
				const lastUploadedBytes = uploadedBytes;

				/* istanbul ignore next: future versions of Node may not have this property */
				if (!is.string((request as any)._header)) {
					clearInterval(progressInterval);

					const url = new URL('https://github.com/sindresorhus/got/issues/new');
					url.searchParams.set('title', '`request._header` is not present');
					url.searchParams.set('body', 'It causes `uploadProgress` to fail.');

					console.warn('`request._header` is not present. Please report this as a bug:\n' + url.href);
					return;
				}

				const headersSize = Buffer.byteLength((request as any)._header);
				uploadedBytes = socket.bytesWritten - headersSize;

				// Don't emit events with unchanged progress and
				// prevent last event from being emitted, because
				// it's emitted when `response` is emitted
				if (uploadedBytes === lastUploadedBytes || uploadedBytes === uploadBodySize) {
					return;
				}

				emitter.emit('uploadProgress', {
					percent: uploadBodySize ? uploadedBytes / uploadBodySize : 0,
					transferred: uploadedBytes,
					total: uploadBodySize
				});
			}, uploadEventFrequency);
		};

		/* istanbul ignore next: hard to test */
		if (socket.connecting) {
			socket.once('connect', onSocketConnect);
		} else if (socket.writable) {
			// The socket is being reused from pool,
			// so the connect event will not be emitted
			onSocketConnect();
		}
	});
}
