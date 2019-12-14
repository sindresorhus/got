/* istanbul ignore file */
import {ClientRequest, RequestOptions, IncomingMessage, IncomingHttpHeaders} from 'http';
import dynamicRequire from './dynamic-require';

interface AuthInfo {
	isProxy: boolean;
	scheme: string;
	host: string;
	port: number;
	realm: string;
}

const discardedHeaderDuplicates = new Set([
	'age',
	'authorization',
	'content-length',
	'content-type',
	'etag',
	'expires',
	'from',
	'host',
	'if-modified-since',
	'if-unmodified-since',
	'last-modified',
	'location',
	'max-forwards',
	'proxy-authorization',
	'referer',
	'retry-after',
	'server',
	'user-agent'
]);

let hasShownDeprecation = false;

export default (url: URL, options: RequestOptions, callback?: (response: IncomingMessage) => void): ClientRequest => {
	if (!hasShownDeprecation) {
		hasShownDeprecation = true;

		console.log('Got: Electron support has been deprecated due to its incompatibility with the Node.js `net` module. It will be removed in the next major version.');
	}

	const electron = dynamicRequire(module, 'electron') as any; // Trick webpack

	const requestFn = electron.net.request ?? electron.remote.net.request;

	// @ts-ignore
	options.redirect = 'manual';

	if (Reflect.has(options, 'electronSession')) {
		// @ts-ignore
		options.session = options.electronSession;
	}

	if (Reflect.has(options.headers!, 'content-length')) {
		delete options.headers['content-length'];
	}

	if (url.hostname !== 'unix') {
		// @ts-ignore
		options.url = url.toString();
	}

	const request = requestFn(options, callback);
	request.once('redirect', (statusCode: number, _newMethod: string, _newUrl: string, headers: {[key: string]: string[]}) => {
		const response = new IncomingMessage({} as any);

		const fixedHeaders: IncomingHttpHeaders = {};

		for (const [header, value] of Object.entries(headers)) {
			if (discardedHeaderDuplicates.has(header)) {
				fixedHeaders[header] = value[0];
			} else if (header === 'set-cookie') {
				fixedHeaders[header] = value;
			} else if (header === 'cookie') {
				fixedHeaders.cookie = value.join(';');
			} else {
				fixedHeaders[header] = value.join(',');
			}
		}

		response.headers = fixedHeaders;
		response.statusCode = statusCode;
		response.complete = true;
		response.push(null);

		request.emit('response', response);
		request.abort();
	});

	const emit = request.emit.bind(request);
	request.emit = (event: string, ...args: any[]): boolean => {
		if (event === 'response') {
			const electronResponse = args[0];
			let {statusMessage} = electronResponse;

			const response = new Proxy(electronResponse, {
				get: (target, name) => {
					if (name === 'trailers' || name === 'rawTrailers') {
						return [];
					}

					if (name === 'statusMessage') {
						return statusMessage;
					}

					if (name === 'socket') {
						return {};
					}

					if (name === 'headers') {
						const {headers} = electronResponse;

						if (Reflect.has(headers, 'content-encoding')) {
							delete headers['content-encoding'];
						}

						return headers;
					}

					const value = target[name];
					return typeof value === 'function' ? value.bind(target) : value;
				},
				set: (target, name, value) => {
					if (name === 'statusMessage') {
						statusMessage = value;

						return true;
					}

					return Reflect.set(target, name, value);
				}
			});

			args[0] = response;
		}

		return emit(event, ...args);
	};

	request.once('login', (_authInfo: AuthInfo, callback: (username?: string, password?: string) => void) => {
		callback();
	});

	return request;
};
