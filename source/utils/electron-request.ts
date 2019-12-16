/* istanbul ignore file */
import {deprecate} from 'util';
import {ClientRequest, RequestOptions, IncomingMessage} from 'http';
import dynamicRequire from './dynamic-require';

export default deprecate((url: URL, options: RequestOptions, callback?: (response: IncomingMessage) => void): ClientRequest => {
	if (Reflect.has(options.headers!, 'content-length')) {
		delete options.headers['content-length'];
	}

	if (url.hostname !== 'unix') {
		// @ts-ignore
		options.url = url.toString();
	}

	const electron = dynamicRequire(module, 'electron') as any; // Trick webpack
	const requestFn = electron.net.request ?? electron.remote.net.request;
	const request = requestFn(options, callback);

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

	return request;
}, 'Electron support has been deprecated due to its incompatibility with the Node.js `net` module. It will be removed in the next major version.', 'GOT_ELECTRON');
