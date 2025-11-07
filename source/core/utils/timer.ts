import {errorMonitor} from 'node:events';
import {types} from 'node:util';
import type {ClientRequest, IncomingMessage} from 'node:http';
import type {Socket} from 'node:net';
import deferToConnect from './defer-to-connect.js';

export type Timings = {
	start: number;
	socket?: number;
	lookup?: number;
	connect?: number;
	secureConnect?: number;
	upload?: number;
	response?: number;
	end?: number;
	error?: number;
	abort?: number;
	phases: {
		wait?: number;
		dns?: number;
		tcp?: number;
		tls?: number;
		request?: number;
		firstByte?: number;
		download?: number;
		total?: number;
	};
};

export type ClientRequestWithTimings = ClientRequest & {
	timings?: Timings;
};

export type IncomingMessageWithTimings = IncomingMessage & {
	timings?: Timings;
};

type SocketWithConnectionTimings = Socket & {
	__initial_connection_timings__?: {
		dnsPhase: number;
		tcpPhase: number;
		tlsPhase?: number;
	};
};

const timer = (request: ClientRequestWithTimings): Timings => {
	if (request.timings) {
		return request.timings;
	}

	const timings: Timings = {
		start: Date.now(),
		socket: undefined,
		lookup: undefined,
		connect: undefined,
		secureConnect: undefined,
		upload: undefined,
		response: undefined,
		end: undefined,
		error: undefined,
		abort: undefined,
		phases: {
			wait: undefined,
			dns: undefined,
			tcp: undefined,
			tls: undefined,
			request: undefined,
			firstByte: undefined,
			download: undefined,
			total: undefined,
		},
	};

	request.timings = timings;

	const handleError = (origin: ClientRequest | IncomingMessage) => {
		origin.once(errorMonitor, () => {
			timings.error = Date.now();
			timings.phases.total = timings.error - timings.start;
		});
	};

	handleError(request);

	const onAbort = () => {
		timings.abort = Date.now();
		timings.phases.total = timings.abort - timings.start;
	};

	request.prependOnceListener('abort', onAbort);

	const onSocket = (socket: SocketWithConnectionTimings) => {
		timings.socket = Date.now();
		timings.phases.wait = timings.socket - timings.start;

		if (types.isProxy(socket)) {
			// HTTP/2: The socket is a proxy, so connection events won't fire.
			// We can't measure connection timings, so leave them undefined.
			// This prevents NaN in phases.request calculation.
			return;
		}

		// Check if socket is already connected (reused from connection pool)
		const socketAlreadyConnected = socket.writable && !socket.connecting;

		if (socketAlreadyConnected) {
			// Socket reuse detected: the socket was already connected from a previous request.
			// For reused sockets, set all connection timestamps to socket time since no new
			// connection was made for THIS request. But preserve phase durations from the
			// original connection so they're not lost.
			timings.lookup = timings.socket;
			timings.connect = timings.socket;

			if (socket.__initial_connection_timings__) {
				// Restore the phase timings from the initial connection
				timings.phases.dns = socket.__initial_connection_timings__.dnsPhase;
				timings.phases.tcp = socket.__initial_connection_timings__.tcpPhase;
				timings.phases.tls = socket.__initial_connection_timings__.tlsPhase;

				// Set secureConnect timestamp if there was TLS
				if (timings.phases.tls !== undefined) {
					timings.secureConnect = timings.socket;
				}
			} else {
				// Socket reused but no initial timings stored (e.g., from external code)
				// Set phases to 0
				timings.phases.dns = 0;
				timings.phases.tcp = 0;
			}

			return;
		}

		const lookupListener = () => {
			timings.lookup = Date.now();
			timings.phases.dns = timings.lookup - timings.socket!;
		};

		socket.prependOnceListener('lookup', lookupListener);

		deferToConnect(socket, {
			connect() {
				timings.connect = Date.now();
				if (timings.lookup === undefined) {
					// No DNS lookup occurred (e.g., connecting to an IP address directly)
					// Set lookup to socket time (no time elapsed for DNS)
					socket.removeListener('lookup', lookupListener);
					timings.lookup = timings.socket!;
					timings.phases.dns = 0;
				}

				timings.phases.tcp = timings.connect - timings.lookup;

				// Store connection phase timings on socket for potential reuse
				if (!socket.__initial_connection_timings__) {
					socket.__initial_connection_timings__ = {
						dnsPhase: timings.phases.dns!,
						// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- TypeScript can't prove this is defined due to callback structure
						tcpPhase: timings.phases.tcp!,
					};
				}
			},
			secureConnect() {
				timings.secureConnect = Date.now();
				timings.phases.tls = timings.secureConnect - timings.connect!;

				// Update stored timings with TLS phase timing
				if (socket.__initial_connection_timings__) {
					socket.__initial_connection_timings__.tlsPhase = timings.phases.tls;
				}
			},
		});
	};

	if (request.socket) {
		onSocket(request.socket as SocketWithConnectionTimings);
	} else {
		request.prependOnceListener('socket', onSocket as (socket: Socket) => void);
	}

	const onUpload = () => {
		timings.upload = Date.now();

		// Calculate request phase if we have connection timings
		const secureOrConnect = timings.secureConnect ?? timings.connect;
		if (secureOrConnect !== undefined) {
			timings.phases.request = timings.upload - secureOrConnect;
		}
		// If both are undefined (HTTP/2), phases.request stays undefined (not NaN)
	};

	if (request.writableFinished) {
		onUpload();
	} else {
		request.prependOnceListener('finish', onUpload);
	}

	request.prependOnceListener('response', (response: IncomingMessageWithTimings) => {
		timings.response = Date.now();
		timings.phases.firstByte = timings.response - timings.upload!;

		response.timings = timings;
		handleError(response);

		response.prependOnceListener('end', () => {
			request.off('abort', onAbort);
			response.off('aborted', onAbort);

			if (timings.phases.total !== undefined) {
				// Aborted or errored
				return;
			}

			timings.end = Date.now();
			timings.phases.download = timings.end - timings.response!;
			timings.phases.total = timings.end - timings.start;
		});

		response.prependOnceListener('aborted', onAbort);
	});

	return timings;
};

export default timer;
