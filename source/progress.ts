import {IncomingMessage, ClientRequest} from 'http';
import {Transform as TransformStream} from 'stream';
import {Socket} from 'net';
import EventEmitter = require('events');

export function downloadProgress(_response: IncomingMessage, emitter: EventEmitter, downloadBodySize?: number): TransformStream {
	let downloadedBytes = 0;

	return new TransformStream({
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
				/* istanbul ignore next: see #490 (occurs randomly!) */
				const headersSize = (request as any)._header ? Buffer.byteLength((request as any)._header) : 0;
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
