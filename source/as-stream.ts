import {PassThrough as PassThroughStream, Duplex as DuplexStream} from 'stream';
import stream = require('stream');
import {IncomingMessage} from 'http';
import duplexer3 = require('duplexer3');
import requestAsEventEmitter from './request-as-event-emitter';
import {HTTPError, ReadError} from './errors';
import {NormalizedOptions, Response} from './utils/types';

export class ProxyStream extends DuplexStream {
	isFromCache?: boolean;
}

export default function asStream(options: NormalizedOptions): ProxyStream {
	const input = new PassThroughStream();
	const output = new PassThroughStream();
	const proxy = duplexer3(input, output) as ProxyStream;
	const piped = new Set<any>(); // TODO: Should be `new Set<ProxyStream>();`.
	let isFinished = false;

	options.retry.calculateDelay = () => 0;

	if (options.body) {
		proxy.write = () => {
			proxy.destroy();
			throw new Error('Got\'s stream is not writable when the `body` option is used');
		};
	}

	const emitter = requestAsEventEmitter(options, input);

	const emitError = async (error: Error): Promise<void> => {
		try {
			for (const hook of options.hooks.beforeError) {
				// eslint-disable-next-line no-await-in-loop
				error = await hook(error);
			}

			proxy.emit('error', error);
		} catch (error_) {
			proxy.emit('error', error_);
		}
	};

	// Cancels the request
	proxy._destroy = (error, callback) => {
		callback(error);
		emitter.abort();
	};

	emitter.on('response', (response: Response) => {
		const {statusCode, isFromCache} = response;
		proxy.isFromCache = isFromCache;

		if (options.throwHttpErrors && statusCode !== 304 && (statusCode < 200 || statusCode > 299)) {
			emitError(new HTTPError(response, options));
			return;
		}

		{
			const read = proxy._read.bind(proxy);
			proxy._read = (...args) => {
				isFinished = true;
				return read(...args);
			};
		}

		stream.pipeline(
			response,
			output,
			error => {
				if (error) {
					emitError(new ReadError(error, options));
				}
			}
		);

		for (const destination of piped) {
			if (destination.headersSent) {
				continue;
			}

			for (const [key, value] of Object.entries(response.headers)) {
				// Got gives *decompressed* data. Overriding `content-encoding` header would result in an error.
				// It's not possible to decompress already decompressed data, is it?
				const allowed = options.decompress ? key !== 'content-encoding' : true;
				if (allowed) {
					destination.setHeader(key, value);
				}
			}

			destination.statusCode = response.statusCode;
		}

		proxy.emit('response', response);
	});

	const events = [
		'error',
		'request',
		'redirect',
		'uploadProgress',
		'downloadProgress'
	];

	for (const event of events) {
		emitter.on(event, (...args) => {
			proxy.emit(event, ...args);
		});
	}

	const pipe = proxy.pipe.bind(proxy);
	const unpipe = proxy.unpipe.bind(proxy);

	proxy.pipe = (destination, options) => {
		if (isFinished) {
			throw new Error('Failed to pipe. The response has been emitted already.');
		}

		pipe(destination, options);

		if (Reflect.has(destination, 'setHeader')) {
			piped.add(destination);
		}

		return destination;
	};

	proxy.unpipe = stream => {
		piped.delete(stream);
		return unpipe(stream);
	};

	proxy.on('pipe', source => {
		if (source instanceof IncomingMessage) {
			options.headers = {
				...source.headers,
				...options.headers
			};
		}
	});

	proxy.isFromCache = undefined;

	return proxy;
}
