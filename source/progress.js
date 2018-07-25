'use strict';
module.exports = {
	upload(req, emitter, uploadBodySize) {
		const uploadEventFrequency = 150;
		let uploaded = 0;
		let progressInterval;

		emitter.emit('uploadProgress', {
			percent: 0,
			transferred: 0,
			total: uploadBodySize
		});

		req.once('error', () => {
			clearInterval(progressInterval);
		});

		req.once('response', () => {
			clearInterval(progressInterval);

			emitter.emit('uploadProgress', {
				percent: 1,
				transferred: uploaded,
				total: uploadBodySize
			});
		});

		req.once('socket', socket => {
			const onSocketConnect = () => {
				progressInterval = setInterval(() => {
					if (socket.destroyed) {
						clearInterval(progressInterval);
						return;
					}

					const lastUploaded = uploaded;
					const headersSize = req._header ? Buffer.byteLength(req._header) : 0;
					uploaded = socket.bytesWritten - headersSize;

					// Prevent the known issue of `bytesWritten` being larger than body size
					if (uploadBodySize && uploaded > uploadBodySize) {
						uploaded = uploadBodySize;
					}

					// Don't emit events with unchanged progress and
					// prevent last event from being emitted, because
					// it's emitted when `response` is emitted
					if (uploaded === lastUploaded || uploaded === uploadBodySize) {
						return;
					}

					emitter.emit('uploadProgress', {
						percent: uploadBodySize ? uploaded / uploadBodySize : 0,
						transferred: uploaded,
						total: uploadBodySize
					});
				}, uploadEventFrequency);
			};

			if (socket.connecting) {
				socket.once('connect', onSocketConnect);
			} else {
				// The socket is being reused from pool,
				// so the connect event will not be emitted
				onSocketConnect();
			}
		});
	}
};
