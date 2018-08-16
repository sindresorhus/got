'use strict';

const {isIP} = require('net');

const listenerRegistry = Symbol('events');
const adapters = {
	error: eventHandler('on', 'error'),
	redirect: eventHandler('on', 'redirect'),
	request: eventHandler('once', 'request'),
	'request.abort': requestEventHandler('once', 'abort'),
	'request.connect': requestEventHandler('on', 'connect'),
	'request.continue': requestEventHandler('on', 'continue'),
	'request.timeout': requestEventHandler('once', 'timeout'),
	'request.upgrade': requestEventHandler('on', 'upgrade'),
	'request.close': requestEventHandler('once', 'close'),
	'request.drain': requestEventHandler('on', 'drain'),
	'request.error': requestEventHandler('on', 'error'),
	'request.finish': requestEventHandler('once', 'finish'),
	'request.pipe': requestEventHandler('on', 'pipe'),
	'request.unpipe': requestEventHandler('on', 'pipe'),
	'request.socket': requestEventHandler('once', 'socket'),
	'request.socket.close': requestSocketEventHandler('once', 'close'),
	'request.socket.connect': requestSocketConnectingEventHandler('connect'),
	'request.socket.secureConnect': requestSocketConnectingEventHandler('secureConnect'),
	'request.socket.data': requestSocketEventHandler('on', 'data'),
	'request.socket.drain': requestSocketEventHandler('on', 'drain'),
	'request.socket.end': requestSocketEventHandler('once', 'end'),
	'request.socket.error': requestSocketEventHandler('on', 'error'),
	'request.socket.lookup': requestSocketLookupHandler(),
	'request.socket.timeout': requestSocketEventHandler('once', 'timeout'),
	'request.response': requestEventHandler('once', 'response'),
	'request.response.aborted': requestResponseEventHandler('once', 'aborted'),
	'request.response.close': requestResponseEventHandler('once', 'close'),
	'request.response.data': requestResponseEventHandler('on', 'data'),
	'request.response.end': requestResponseEventHandler('once', 'end'),
	'request.response.error': requestResponseEventHandler('on', 'error'),
	'request.response.readable': requestResponseEventHandler('on', 'readable'),
	response: eventHandler('once', 'response'),
	'response.aborted': responseEventHandler('once', 'aborted'),
	'response.close': responseEventHandler('once', 'close'),
	'response.data': responseEventHandler('on', 'data'),
	'response.end': responseEventHandler('once', 'end'),
	'response.error': responseEventHandler('on', 'error'),
	'response.readable': responseEventHandler('on', 'readable'),
	uploadProgress: eventHandler('on', 'uploadProgress'),
	downloadProgress: eventHandler('on', 'downloadProgress')
};

function eventHandler(method, event) {
	return (emitter, handlers, context) => {
		attachListener(emitter, method, event, handlers, context);
	};
}

function requestEventHandler(method, event) {
	return (emitter, handlers, context) => {
		emitter.once('request', request => {
			attachListener(request, method, event, handlers, context);
		});
	};
}

function requestSocketEventHandler(method, event) {
	return (emitter, handlers, context) => {
		emitter.once('request', request => {
			request.once('socket', socket => {
				attachListener(socket, method, event, handlers, context);
			});
		});
	};
}

function requestSocketConnectingEventHandler(event) {
	return (emitter, handlers, context) => {
		emitter.once('request', request => {
			request.once('socket', socket => {
				if (socket.connecting) {
					attachListener(socket, 'once', event, handlers, context);
				}
			});
		});
	};
}

function requestSocketLookupHandler() {
	return (emitter, handlers, context) => {
		const {options: {hostname, host, socketPath}} = context.options;
		if (!socketPath && !isIP(hostname || host)) {
			emitter.once('request', request => {
				request.once('socket', socket => {
					if (socket.connecting) {
						attachListener(socket, 'once', 'lookup', handlers, context);
					}
				});
			});
		}
	};
}

function responseEventHandler(method, event) {
	return (emitter, handlers, context) => {
		emitter.once('response', response => {
			attachListener(response, method, event, handlers, context);
		});
	};
}

function requestResponseEventHandler(method, event) {
	return (emitter, handlers, context) => {
		emitter.once('request', request => {
			request.once('response', response => {
				attachListener(response, method, event, handlers, context);
			});
		});
	};
}

function attachListener(emitter, method, event, handlers, context) {
	if (!Reflect.has(context, listenerRegistry)) {
		context[listenerRegistry] = [];
	}
	const registry = context[listenerRegistry];
	const listener = (...args) => {
		handlers.forEach(handler => handler(...args, context));
	};
	emitter[method](event, listener);
	registry.push({emitter, event, listener});
}

module.exports = (emitter, options) => {
	const context = {options};
	for (const [event, handlers] of Object.entries(options.events || {})) {
		if (event in adapters) {
			adapters[event](emitter, handlers, context);
		}
	}
	const clearListeners = () => {
		const {[listenerRegistry]: registry = []} = options;
		registry.forEach(({emitter, event, listener}) => {
			emitter.removeListener(event, listener);
		});
	};
	emitter.on('error', clearListeners);
	emitter.on('request', request => {
		request.once('response', response => {
			response.once('end', clearListeners);
		});
	});
};
