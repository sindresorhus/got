/* eslint-disable @typescript-eslint/member-ordering, @typescript-eslint/naming-convention, @typescript-eslint/no-restricted-types, @typescript-eslint/no-deprecated, promise/prefer-await-to-then */
import {Buffer} from 'node:buffer';
import {EventEmitter} from 'node:events';
import http, {
	type Agent as HttpAgent, type ClientRequest, type IncomingMessage, validateHeaderName, validateHeaderValue,
} from 'node:http';
import http2, {type ClientHttp2Session, type ClientHttp2Stream} from 'node:http2';
import https, {type Agent as HttpsAgent, type RequestOptions as HttpsRequestOptions} from 'node:https';
import {Writable, Readable} from 'node:stream';
import tls from 'node:tls';
import {urlToHttpOptions} from 'node:url';
import net, {type Socket} from 'node:net';
import {TimeoutError} from '../timed-out.js';

const {
	HTTP2_HEADER_AUTHORITY,
	HTTP2_HEADER_METHOD,
	HTTP2_HEADER_PATH,
	HTTP2_HEADER_SCHEME,
	HTTP2_HEADER_STATUS,
	HTTP2_METHOD_CONNECT,
	NGHTTP2_CANCEL,
} = http2.constants;

type RequestCallback = (response: IncomingMessage) => void;
type RequestHeaders = Record<string, string | string[] | number | undefined>;
type Http2AgentOptions = {
	timeout?: number;
	maxSessions?: number;
	maxEmptySessions?: number;
};

type Http2Session = ClientHttp2Session & {
	currentStreamCount?: number;
	emptySessionCounted?: boolean;
	gracefullyClosing?: boolean;
};

type QueueEntry = {
	origin: URL;
	options: NormalizedRequestOptions;
	resolve: (session: Http2Session) => void;
	reject: (error: Error) => void;
};

type NormalizedRequestOptions = Omit<HttpsRequestOptions, 'agent' | 'createConnection'> & {
	agent?: any;
	createConnection?: any;
	ALPNProtocols?: string[];
	settings?: http2.Settings;
	h2session?: ClientHttp2Session;
	_reuseSocket?: Socket;
	_alpnSocket?: Socket;
};

type AgentObject = {
	http?: HttpAgent | false;
	https?: HttpsAgent | false;
	http2?: Http2Agent | false;
};

const maxProtocolCacheSize = 100;
const protocolCache = new Map<string, string | false>();
const connectionSpecificHeaders = new Set([
	'connection',
	'http2-settings',
	'keep-alive',
	'proxy-connection',
	'transfer-encoding',
	'upgrade',
]);

const isTrailersTeHeader = (value: string | string[] | number | undefined): boolean => {
	if (value === undefined) {
		return true;
	}

	if (Array.isArray(value)) {
		return value.length === 1 && value[0]!.toLowerCase() === 'trailers';
	}

	return String(value).trim().toLowerCase() === 'trailers';
};

const setProtocolCache = (key: string, value: string | false): void => {
	if (!protocolCache.has(key) && protocolCache.size >= maxProtocolCacheSize) {
		protocolCache.delete(protocolCache.keys().next().value!);
	}

	protocolCache.set(key, value);
};

const normalizeInput = (
	input: string | URL | HttpsRequestOptions,
	options?: HttpsRequestOptions | RequestCallback,
	callback?: RequestCallback,
): {options: NormalizedRequestOptions; callback?: RequestCallback} => {
	let normalizedOptions: NormalizedRequestOptions;

	if (typeof input === 'string') {
		normalizedOptions = urlToHttpOptions(new URL(input));
	} else if (input instanceof URL) {
		normalizedOptions = urlToHttpOptions(input);
	} else {
		normalizedOptions = {...input};
	}

	if (typeof options === 'function' || options === undefined) {
		callback = options;
	} else {
		normalizedOptions = {
			...normalizedOptions,
			...options,
		};
	}

	return {options: normalizedOptions, callback};
};

const getAuthority = (options: HttpsRequestOptions): URL => {
	const protocol = options.protocol ?? 'https:';
	const hostname = options.hostname ?? options.host ?? 'localhost';
	const port = options.port ?? (protocol === 'https:' ? 443 : 80);
	const hostnameString = String(hostname);
	const normalizedHostname = hostnameString.startsWith('[') && hostnameString.endsWith(']')
		? hostnameString.slice(1, -1)
		: hostnameString;
	const formattedHostname = net.isIP(normalizedHostname) === 6 ? `[${normalizedHostname}]` : normalizedHostname;
	const authority = new URL(`${protocol}//${formattedHostname}`);
	authority.port = String(port);

	return authority;
};

const getAuthorityPort = (authority: URL): number => {
	if (authority.port !== '') {
		return Number(authority.port);
	}

	return authority.protocol === 'https:' ? 443 : 80;
};

const getConnectionHostname = (authority: URL): string => {
	const {hostname} = authority;

	return hostname.startsWith('[') && hostname.endsWith(']')
		? hostname.slice(1, -1)
		: hostname;
};

const hasCustomHttpsAgent = (agent: AgentObject | HttpsAgent | Http2Agent | false | undefined): agent is AgentObject & {https: HttpsAgent} =>
	typeof agent === 'object'
	&& 'https' in agent
	&& agent.https !== undefined
	&& agent.https !== false;

const getProtocolCacheKey = (options: HttpsRequestOptions): string => {
	const authority = getAuthority(options);
	const protocols = [...((options as NormalizedRequestOptions).ALPNProtocols ?? ['h2', 'http/1.1'])].sort().join(',');

	return `${authority.host}:${protocols}:${options.servername ?? ''}:${options.rejectUnauthorized ?? ''}`;
};

const resolveProtocol = async (
	options: NormalizedRequestOptions,
	sourceOptions: NormalizedRequestOptions,
): Promise<{alpnProtocol: string | false; socket?: tls.TLSSocket}> => {
	const cacheKey = getProtocolCacheKey(options);
	const cachedProtocol = options.createConnection ? undefined : protocolCache.get(cacheKey);

	if (cachedProtocol !== undefined) {
		return {alpnProtocol: cachedProtocol};
	}

	const authority = getAuthority(options);
	const {
		path: _path,
		agent: _agent,
		h2session: _h2session,
		_reuseSocket,
		_alpnSocket,
		timeout,
		createConnection,
		checkServerIdentity,
		...connectionOptions
	} = options;
	const port = getAuthorityPort(authority);
	const hostname = getConnectionHostname(authority);
	const servername = options.servername ?? (net.isIP(hostname) === 0 ? hostname : undefined);
	const tlsOptions: tls.ConnectionOptions = {
		...connectionOptions,
		ALPNProtocols: options.ALPNProtocols ?? ['h2', 'http/1.1'],
		host: hostname,
		port,
		servername,
	};

	if (checkServerIdentity) {
		tlsOptions.checkServerIdentity = checkServerIdentity as tls.ConnectionOptions['checkServerIdentity'];
	}

	const socket = createConnection
		? createConnection(tlsOptions, () => {}) as tls.TLSSocket
		: tls.connect(port, hostname, tlsOptions);
	options._alpnSocket = socket;
	sourceOptions._alpnSocket = socket;

	return new Promise((resolve, reject) => {
		let settled = false;
		let timeoutId: NodeJS.Timeout | undefined;
		let removeAbortListener: (() => void) | undefined;

		const cleanup = () => {
			if (timeoutId) {
				clearTimeout(timeoutId);
			}

			removeAbortListener?.();
			socket.off('secureConnect', onSecureConnect);
			socket.off('error', onError);
			socket.off('close', onClose);
			delete options._alpnSocket;
			delete sourceOptions._alpnSocket;
		};

		const rejectOnce = (error: Error) => {
			if (settled) {
				return;
			}

			settled = true;
			cleanup();
			socket.destroy();
			reject(error);
		};

		const onSecureConnect = () => {
			if (settled) {
				return;
			}

			settled = true;
			cleanup();
			const alpnProtocol = socket.alpnProtocol ?? false;
			if (!options.createConnection) {
				setProtocolCache(cacheKey, alpnProtocol);
			}

			resolve({alpnProtocol, socket});
		};

		const onError = (error: Error) => {
			rejectOnce(error);
		};

		const onTimeout = () => {
			rejectOnce(new TimeoutError(Number(timeout), 'request'));
		};

		const onClose = () => {
			const error = new Error('The HTTP/2 ALPN socket closed before negotiation completed') as NodeJS.ErrnoException;
			error.code = 'ECONNRESET';
			rejectOnce(error);
		};

		const onAbort = () => {
			const error = new Error('This operation was aborted.') as NodeJS.ErrnoException;
			error.name = 'AbortError';
			error.code = 'ERR_ABORTED';
			rejectOnce(error);
		};

		if (options.signal?.aborted) {
			onAbort();
			return;
		}

		socket.once('secureConnect', onSecureConnect);
		socket.once('error', onError);
		socket.once('close', onClose);

		if (options.signal) {
			options.signal.addEventListener('abort', onAbort, {once: true});
			removeAbortListener = () => {
				options.signal?.removeEventListener('abort', onAbort);
			};
		}

		if (timeout !== undefined) {
			timeoutId = setTimeout(onTimeout, Number(timeout));
			timeoutId.unref();
		}
	});
};

const toRawHeaders = (headers: http2.IncomingHttpHeaders): string[] => {
	const rawHeaders: string[] = [];

	for (const [key, value] of Object.entries(headers)) {
		if (key.startsWith(':') || value === undefined) {
			continue;
		}

		if (Array.isArray(value)) {
			for (const item of value) {
				rawHeaders.push(key, item);
			}
		} else {
			rawHeaders.push(key, String(value));
		}
	}

	return rawHeaders;
};

const createSocketProxy = (stream: ClientHttp2Stream): Socket => new Proxy(stream.session!.socket, {
	get(target, property, receiver) {
		if (property === 'destroy') {
			return stream.destroy.bind(stream);
		}

		if (property === 'destroyed') {
			return stream.destroyed;
		}

		if (property === 'setTimeout') {
			return stream.setTimeout.bind(stream);
		}

		return Reflect.get(target, property, receiver);
	},
});

class Http2IncomingMessage extends Readable {
	readonly stream: ClientHttp2Stream;
	readonly req: Http2ClientRequest;

	constructor(stream: ClientHttp2Stream, request_: Http2ClientRequest, highWaterMark: number) {
		super({
			autoDestroy: true,
			emitClose: false,
			highWaterMark,
		});

		this.stream = stream;
		this.req = request_;
		this.socket = request_.socket!;
	}

	aborted = false;
	httpVersion = '2.0';
	httpVersionMajor = 2;
	httpVersionMinor = 0;
	complete = false;
	rawHeaders: string[] = [];
	rawTrailers: string[] = [];
	headers: IncomingMessage['headers'] = {};
	trailers: IncomingMessage['trailers'] = {};
	statusCode?: number;
	statusMessage?: string;
	socket: Socket;
	url = '';
	method?: string;
	upgrade = false;

	get connection(): Socket {
		return this.socket;
	}

	set connection(value: Socket) {
		this.socket = value;
	}

	setTimeout(ms: number, callback?: () => void): this {
		this.req.setTimeout(ms, callback);
		return this;
	}

	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		if (!this.readableEnded) {
			this.aborted = true;
		}

		this.stream.destroy(error ?? undefined);
		callback();
	}

	override _read(): void {
		this.stream.resume();
	}

	_dump(): void {
		this.removeAllListeners('data');
		this.resume();
	}

	// The remaining IncomingMessage fields are part of Node's public shape, but Got does not use them for HTTP/2 responses.
}

export class Http2Agent extends EventEmitter {
	readonly timeout: number;
	readonly maxSessions: number;
	readonly maxEmptySessions: number;
	readonly sessions = new Map<string, Http2Session[]>();
	readonly queue: QueueEntry[] = [];
	emptySessionCount = 0;
	sessionCount = 0;
	settings: http2.Settings = {
		enablePush: false,
		initialWindowSize: 1024 * 1024 * 32,
	};

	constructor({timeout = 0, maxSessions = Number.POSITIVE_INFINITY, maxEmptySessions = 10}: Http2AgentOptions = {}) {
		super();

		this.timeout = timeout;
		this.maxSessions = maxSessions;
		this.maxEmptySessions = maxEmptySessions;
	}

	get protocol(): 'https:' {
		return 'https:';
	}

	async request(origin: URL, options: NormalizedRequestOptions, headers: RequestHeaders, streamOptions?: http2.ClientSessionRequestOptions): Promise<ClientHttp2Stream> {
		const session = await this.getSession(origin, options);
		return session.request(headers, streamOptions);
	}

	async getSession(origin: string | URL, options: NormalizedRequestOptions = {}): Promise<Http2Session> {
		const normalizedOrigin = typeof origin === 'string' ? new URL(origin) : origin;
		const key = this.normalizeOptions(normalizedOrigin, options);
		const session = options._reuseSocket ? undefined : this.getAvailableSession(key);

		if (session) {
			return session;
		}

		return new Promise((resolve, reject) => {
			this.queue.push({
				origin: normalizedOrigin,
				options,
				resolve,
				reject,
			});

			this.processQueue();
		});
	}

	normalizeOptions(origin: URL, options: NormalizedRequestOptions = {}): string {
		return [
			origin.origin,
			options.ca,
			options.cert,
			options.key,
			options.pfx,
			options.rejectUnauthorized,
			options.servername,
			options.localAddress,
			options.family,
			options.minVersion,
			options.maxVersion,
			options.ciphers,
			options.secureOptions,
		].map(value => {
			if (value === undefined) {
				return '';
			}

			if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
				return String(value);
			}

			return JSON.stringify(value);
		}).join(':');
	}

	closeEmptySessions(maxCount = Number.POSITIVE_INFINITY): number {
		let closedCount = 0;

		for (const sessions of this.sessions.values()) {
			for (const session of sessions) {
				if ((session.currentStreamCount ?? 0) === 0) {
					closedCount++;
					session.close();

					if (closedCount >= maxCount) {
						return closedCount;
					}
				}
			}
		}

		return closedCount;
	}

	destroy(reason?: Error): void {
		for (const sessions of this.sessions.values()) {
			for (const session of sessions) {
				session.destroy(reason);
			}
		}

		this.sessions.clear();

		while (this.queue.length > 0) {
			this.queue.shift()!.reject(reason ?? new Error('Agent has been destroyed'));
		}
	}

	private getAvailableSession(key: string): Http2Session | undefined {
		const sessions = this.sessions.get(key);

		if (!sessions) {
			return;
		}

		return sessions.find(session =>
			!session.destroyed
			&& !session.closed
			&& !session.gracefullyClosing
			&& (session.currentStreamCount ?? 0) < (session.remoteSettings.maxConcurrentStreams ?? 100));
	}

	private processQueue(): void {
		while (this.queue.length > 0) {
			const entry = this.queue[0]!;
			const key = this.normalizeOptions(entry.origin, entry.options);
			const session = entry.options._reuseSocket ? undefined : this.getAvailableSession(key);

			if (session) {
				this.queue.shift();
				entry.resolve(session);
				continue;
			}

			if (this.sessionCount >= this.maxSessions) {
				this.closeEmptySessions(this.sessionCount - this.maxSessions + 1);

				if (this.sessionCount >= this.maxSessions) {
					return;
				}
			}

			this.queue.shift();
			this.createSession(entry, key);
		}
	}

	private createSession(entry: QueueEntry, key: string): void {
		this.sessionCount++;
		const {
			path: _path,
			agent: _agent,
			h2session: _h2session,
			...sessionOptions
		} = entry.options;

		const options: NormalizedRequestOptions = {
			...sessionOptions,
			settings: entry.options.settings ?? this.settings,
			ALPNProtocols: ['h2'],
		};

		const shouldPoolSession = !options._reuseSocket;
		if (options._reuseSocket) {
			const socket = options._reuseSocket;
			options.createConnection = () => socket;
			delete options._reuseSocket;
		}

		const session = http2.connect(entry.origin, options as http2.SecureClientSessionOptions) as Http2Session;
		session.currentStreamCount = 0;
		session.emptySessionCounted = false;
		session.gracefullyClosing = false;
		let settled = false;

		if (this.timeout > 0) {
			session.setTimeout(this.timeout, () => {
				session.destroy();
			});
		}

		const removeSession = () => {
			if (session.emptySessionCounted) {
				this.emptySessionCount--;
				session.emptySessionCounted = false;
			}

			const sessions = this.sessions.get(key);

			if (sessions) {
				const index = sessions.indexOf(session);

				if (index !== -1) {
					sessions.splice(index, 1);
				}

				if (sessions.length === 0) {
					this.sessions.delete(key);
				}
			}
		};

		session.once('remoteSettings', () => {
			settled = true;

			if (shouldPoolSession) {
				const sessions = this.sessions.get(key) ?? [];
				sessions.push(session);
				this.sessions.set(key, sessions);
			}

			this.emit('session', session);
			entry.resolve(session);

			this.processQueue();
		});

		session.once('error', error => {
			settled = true;
			entry.reject(error);
			removeSession();
		});

		session.once('goaway', () => {
			session.gracefullyClosing = true;

			if (session.currentStreamCount === 0) {
				session.close();
			}
		});

		session.once('close', () => {
			this.sessionCount--;
			if (!settled) {
				settled = true;
				entry.reject(new Error('The HTTP/2 session closed before settings were received'));
			}

			removeSession();
			this.processQueue();
		});

		const request = session.request.bind(session);
		session.request = (headers, streamOptions) => {
			if (session.gracefullyClosing) {
				throw new Error('The session is gracefully closing. No new streams are allowed.');
			}

			const stream = request(headers, streamOptions);
			session.ref();

			if (session.currentStreamCount === 0 && session.emptySessionCounted) {
				this.emptySessionCount--;
				session.emptySessionCounted = false;
			}

			session.currentStreamCount = (session.currentStreamCount ?? 0) + 1;

			stream.once('close', () => {
				session.currentStreamCount = session.currentStreamCount! - 1;

				if (session.currentStreamCount === 0) {
					if (!shouldPoolSession) {
						session.close();
						this.processQueue();
						return;
					}

					this.emptySessionCount++;
					session.emptySessionCounted = true;
					session.unref();

					if (this.emptySessionCount > this.maxEmptySessions || session.gracefullyClosing) {
						session.close();
						return;
					}
				}

				this.processQueue();
			});

			return stream;
		};
	}
}

class Http2ClientRequest extends Writable {
	constructor(input: string | URL | NormalizedRequestOptions, options?: NormalizedRequestOptions | RequestCallback, callback?: RequestCallback) {
		super({
			autoDestroy: false,
			emitClose: false,
		});

		const normalized = normalizeInput(input, options, callback);
		this.options = normalized.options;
		this.callback = normalized.callback;
		this.method = (this.options.method ?? 'GET').toUpperCase();
		this.path = this.method === HTTP2_METHOD_CONNECT ? String(this.options.path ?? '') : String(this.options.path ?? '/');
		this.protocol = String(this.options.protocol ?? 'https:');
		this.headers = Object.create(null) as RequestHeaders;

		if (this.protocol !== 'https:' && !this.options.h2session) {
			throw new Error(`Protocol "${this.protocol}" not supported. Expected "https:"`);
		}

		const headers = this.options.headers as RequestHeaders | undefined;

		if (headers) {
			for (const [key, value] of Object.entries(headers)) {
				this.setHeader(key, value);
			}
		}

		if (this.options.auth && !this.hasHeader('authorization')) {
			this.setHeader('authorization', `Basic ${Buffer.from(this.options.auth).toString('base64')}`);
		}

		if (this.callback) {
			this.once('response', this.callback);
		}

		const authority = getAuthority(this.options);
		this.origin = authority;

		if (!this.hasHeader(HTTP2_HEADER_AUTHORITY)) {
			this.headers[HTTP2_HEADER_AUTHORITY] = authority.host;
		}

		this.headers[HTTP2_HEADER_METHOD] = this.method;

		if (this.method !== HTTP2_METHOD_CONNECT) {
			this.headers[HTTP2_HEADER_SCHEME] = this.protocol.slice(0, -1);
			this.headers[HTTP2_HEADER_PATH] = this.path;
		}

		if (this.options.timeout) {
			this.setTimeout(Number(this.options.timeout));
		}
	}

	agent?: Http2Agent;
	aborted = false;
	reusedSocket = true;
	res?: IncomingMessage;
	socket: Socket | undefined;
	connection: Socket | undefined;
	method: string;
	path?: string;
	protocol: string;
	host?: string;
	headersSent = false;
	maxHeadersCount?: number;
	private readonly options: NormalizedRequestOptions;
	private readonly callback?: RequestCallback;
	private readonly headers: RequestHeaders;
	private readonly origin: URL;
	private stream?: ClientHttp2Stream;
	private pendingJobs: Array<() => void> = [];
	private pendingAgentPromise?: Promise<ClientHttp2Stream>;
	private trailers?: RequestHeaders;

	get isGotHttp2Request(): true {
		return true;
	}

	override _write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		void this.flushHeaders();

		const write = () => {
			this.stream!.write(chunk, encoding, callback);
		};

		if (this.stream) {
			write();
		} else {
			this.pendingJobs.push(write);
		}
	}

	override _final(callback: (error?: Error | null) => void): void {
		void this.flushHeaders();

		const end = () => {
			if (this.trailers) {
				this.stream!.once('wantTrailers', () => {
					this.stream!.sendTrailers(this.trailers as http2.OutgoingHttpHeaders);
				});
			}

			this.stream!.end(callback);
		};

		if (this.stream) {
			end();
		} else {
			this.pendingJobs.push(end);
		}
	}

	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		if (this.res && typeof (this.res as any)._dump === 'function') {
			(this.res as any)._dump();
		}

		if (this.stream) {
			if (error) {
				this.stream.destroy(error);
			} else {
				this.stream.close(NGHTTP2_CANCEL);
			}
		} else {
			queueMicrotask(() => {
				this.emit('close');
			});
		}

		if (this.pendingAgentPromise) {
			void this.pendingAgentPromise.catch(() => {});
		}

		callback(error);
	}

	abort(): void {
		if (this.res?.complete) {
			return;
		}

		if (!this.aborted) {
			queueMicrotask(() => {
				this.emit('abort');
			});
		}

		this.aborted = true;
		this.destroy();
	}

	async flushHeaders(): Promise<void> {
		if (this.headersSent || this.destroyed) {
			return;
		}

		this.headersSent = true;

		try {
			if (this.options.h2session) {
				this.onStream(this.options.h2session.request(this.headers, {
					endStream: false,
					waitForTrailers: this.trailers !== undefined,
				}));
				return;
			}

			this.agent = this.options.agent === false ? new Http2Agent({maxEmptySessions: 0}) : this.options.agent as Http2Agent | undefined ?? globalAgent;
			const streamPromise = this.agent.request(this.origin, this.options, this.headers, {
				endStream: false,
				waitForTrailers: this.trailers !== undefined,
			});
			this.pendingAgentPromise = streamPromise;
			this.onStream(await streamPromise);
			this.pendingAgentPromise = undefined;
		} catch (error: unknown) {
			this.pendingAgentPromise = undefined;
			this.destroy(error as Error);
		}
	}

	addTrailers(headers: RequestHeaders): void {
		this.trailers = headers;
	}

	setHeader(name: string, value: string | string[] | number | undefined): this {
		if (this.headersSent) {
			throw new Error('Cannot set headers after they are sent to the client');
		}

		validateHeaderName(name);

		if (value !== undefined) {
			validateHeaderValue(name, value as any);
		}

		const lowercasedName = name.toLowerCase();

		if (connectionSpecificHeaders.has(lowercasedName)) {
			return this;
		}

		if (lowercasedName === 'te' && !isTrailersTeHeader(value)) {
			return this;
		}

		if (lowercasedName === 'host') {
			this.headers[HTTP2_HEADER_AUTHORITY] = value;
		} else {
			this.headers[lowercasedName] = value;
		}

		return this;
	}

	getHeader(name: string): string | number | string[] | undefined {
		return this.headers[name.toLowerCase()];
	}

	getHeaders(): RequestHeaders {
		return {...this.headers};
	}

	getHeaderNames(): string[] {
		return Object.keys(this.headers);
	}

	hasHeader(name: string): boolean {
		return this.getHeader(name) !== undefined;
	}

	removeHeader(name: string): void {
		if (this.headersSent) {
			throw new Error('Cannot remove headers after they are sent to the client');
		}

		Reflect.deleteProperty(this.headers, name.toLowerCase());
	}

	setNoDelay(): void {}

	setSocketKeepAlive(): void {}

	setTimeout(ms: number, callback?: () => void): this {
		const applyTimeout = () => {
			this.stream!.setTimeout(ms, callback);
		};

		if (this.stream) {
			applyTimeout();
		} else {
			this.pendingJobs.push(applyTimeout);
		}

		return this;
	}

	private onStream(stream: ClientHttp2Stream): void {
		this.stream = stream;
		this.socket = createSocketProxy(stream);
		this.connection = this.socket;

		if (this.destroyed) {
			stream.destroy();
			return;
		}

		stream.once('error', error => {
			if (this.destroyed) {
				return;
			}

			this.destroy(error);
		});

		stream.once('aborted', () => {
			if (this.res) {
				this.res.aborted = true;
				this.res.emit('aborted');
				this.res.destroy();
			} else {
				this.destroy(new Error('The server aborted the HTTP/2 stream'));
			}
		});

		stream.once('response', (headers, _flags, rawHeaders) => {
			const response = new Http2IncomingMessage(stream, this, stream.readableHighWaterMark);
			const incomingResponse = response as unknown as IncomingMessage & {req: ClientRequest; _dump: () => void};
			response.statusCode = Number(headers[HTTP2_HEADER_STATUS]);
			response.headers = headers;
			response.rawHeaders = rawHeaders ?? toRawHeaders(headers);
			response.url = `${this.origin.origin}${this.path}`;
			incomingResponse.req = this as unknown as ClientRequest;
			this.res = incomingResponse;

			stream.on('data', chunk => {
				if (!response.push(chunk)) {
					stream.pause();
				}
			});

			stream.once('end', () => {
				if (!this.aborted) {
					response.complete = true;
					response.push(null);
				}
			});

			if (!this.emit('response', incomingResponse)) {
				response._dump();
			}
		});

		stream.once('headers', headers => {
			this.emit('information', {statusCode: headers[HTTP2_HEADER_STATUS]});
		});

		stream.once('trailers', (trailers, _flags, rawTrailers) => {
			if (!this.res) {
				return;
			}

			this.res.trailers = trailers as IncomingMessage['trailers'];
			this.res.rawTrailers = Array.isArray(rawTrailers) ? rawTrailers : toRawHeaders(trailers);
		});

		stream.once('close', () => {
			if (this.res) {
				if (this.aborted) {
					this.res.aborted = true;
					this.res.emit('aborted');
					this.res.destroy();
				}

				const finish = () => {
					this.res!.emit('close');
					this.destroy();
					this.emit('close');
				};

				if (this.res.readable) {
					this.res.once('end', finish);
				} else {
					finish();
				}

				return;
			}

			if (!this.destroyed) {
				this.destroy(new Error('The HTTP/2 stream has been early terminated'));
				queueMicrotask(() => {
					this.emit('close');
				});
				return;
			}

			this.destroy();
			this.emit('close');
		});

		for (const job of this.pendingJobs) {
			job();
		}

		this.pendingJobs = [];
		this.emit('socket', this.socket);
	}
}

export const globalAgent = new Http2Agent();

export const request = (
	url: URL,
	options: NormalizedRequestOptions,
	callback?: RequestCallback,
): ClientRequest => new Http2ClientRequest(url, options, callback) as unknown as ClientRequest;

export const auto = async (input: URL, options: NormalizedRequestOptions, callback?: RequestCallback): Promise<ClientRequest> => {
	const sourceOptions = options;
	options = {
		...urlToHttpOptions(input),
		...options,
	};
	options.ALPNProtocols ??= ['h2', 'http/1.1'];
	options.protocol ??= 'https:';

	if (options.h2session) {
		return request(input, options, callback);
	}

	const isHttps = options.protocol === 'https:';

	if (!isHttps) {
		options.agent = (options.agent as AgentObject | undefined)?.http;
		return http.request(options as http.RequestOptions, callback);
	}

	const agent = options.agent as AgentObject | HttpsAgent | Http2Agent | false | undefined;
	if (hasCustomHttpsAgent(agent) && options.createConnection === undefined) {
		options.agent = agent.https;
		return https.request(options as HttpsRequestOptions, callback);
	}

	const {alpnProtocol, socket} = await resolveProtocol(options, sourceOptions);
	const isHttp2 = alpnProtocol === 'h2';

	if (isHttp2) {
		options.agent = typeof agent === 'object' && 'http2' in agent ? agent.http2 : agent as Http2Agent | false | undefined;

		if (socket) {
			options._reuseSocket = socket;
		}

		return request(input, options, callback);
	}

	socket?.destroy();

	if (typeof agent === 'object' && 'https' in agent) {
		options.agent = agent.https;
	}

	if (options.headers) {
		const headers: Record<string, any> = {...options.headers};
		Reflect.deleteProperty(headers, HTTP2_HEADER_METHOD);
		Reflect.deleteProperty(headers, ':scheme');
		Reflect.deleteProperty(headers, HTTP2_HEADER_PATH);

		if (headers[HTTP2_HEADER_AUTHORITY] && !headers.host) {
			headers.host = headers[HTTP2_HEADER_AUTHORITY];
		}

		Reflect.deleteProperty(headers, HTTP2_HEADER_AUTHORITY);
		options.headers = headers;
	}

	return https.request(options as HttpsRequestOptions, callback);
};

const http2Client = {
	Agent: Http2Agent,
	auto,
	globalAgent,
	request,
};

export default http2Client;
