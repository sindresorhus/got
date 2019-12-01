import duplexer3 = require('duplexer3');
import stream = require('stream');
import {IncomingMessage, ServerResponse} from 'http';
import {Duplex as DuplexStream, PassThrough as PassThroughStream} from 'stream';
import {HTTPError, ReadError} from './errors';
import requestAsEventEmitter, {proxyEvents} from './request-as-event-emitter';
import {GeneralError, GotEvents, NormalizedOptions, Response} from './utils/types';

export class ProxyStream<T = unknown> extends DuplexStream implements GotEvents<ProxyStream<T>> {
	isFromCache?: boolean;
}

export default function asStream<T>(options: NormalizedOptions): ProxyStream<T> {
	const input = new PassThroughStream();
	const output = new PassThroughStream();
	const proxy = duplexer3(input, output) as ProxyStream;
	const piped = new Set<ServerResponse>();
	let isFinished = false;

	options.retry.calculateDelay = () => 0;

	if (options.body || options.json || options.form) {
		proxy.write = () => {
			proxy.destroy();
			throw new Error('Got\'s stream is not writable when the `body`, `json` or `form` option is used');
		};
	} else if (options.method === 'POST' || options.method === 'PUT' || options.method === 'PATCH') {
		options.body = input;
	} else {
		proxy.write = () => {
			proxy.destroy();
			throw new TypeError(`The \`${options.method}\` method cannot be used with a body`);
		};
	}

	const emitter = requestAsEventEmitter(options);

	const emitError = async (error: GeneralError): Promise<void> => {
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
				const isAllowed = options.decompress ? key !== 'content-encoding' : true;
				if (isAllowed) {
					destination.setHeader(key, value!);
				}
			}

			destination.statusCode = response.statusCode;
		}

		proxy.emit('response', response);
	});

	proxyEvents(proxy, emitter);
	emitter.on('error', (error: GeneralError) => proxy.emit('error', error));

	const pipe = proxy.pipe.bind(proxy);
	const unpipe = proxy.unpipe.bind(proxy);

	proxy.pipe = (destination, options) => {
		if (isFinished) {
			throw new Error('Failed to pipe. The response has been emitted already.');
		}

		pipe(destination, options);

		if (destination instanceof ServerResponse) {
			piped.add(destination);
		}

		return destination;
	};

	proxy.unpipe = stream => {
		piped.delete(stream as ServerResponse);
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
