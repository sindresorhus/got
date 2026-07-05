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
	reservedStreamCount?: number;
	emptySessionCounted?: boolean;
	gracefullyClosing?: boolean;
};

type QueueEntry = {
	origin: URL;
	options: NormalizedRequestOptions;
	reserveStream: boolean;
	resolve: (result: AgentSessionResult) => void;
	reject: (error: Error) => void;
};

type AgentSessionResult = {
	session: Http2Session;
	reusedSocket: boolean;
};

type AgentRequestResult = {
	stream: ClientHttp2Stream;
	reusedSocket: boolean;
};

type NormalizedRequestOptions = Omit<HttpsRequestOptions, 'agent' | 'createConnection'> & {
	agent?: any;
	createConnection?: any;
	ALPNProtocols?: string[];
	secureContext?: tls.ConnectionOptions['secureContext'];
	secureProtocol?: tls.ConnectionOptions['secureProtocol'];
	settings?: http2.Settings;
	h2session?: ClientHttp2Session;
	_reuseSocket?: Socket;
	_reuseSocketShouldPool?: boolean;
	_alpnSocket?: Socket;
	_cancelSessionSetup?: () => void;
};

type AgentObject = {
	http?: HttpAgent | false;
	https?: HttpsAgent | false;
	http2?: Http2Agent | false;
};

type TlsSessionIdentityOptions = HttpsRequestOptions & Pick<NormalizedRequestOptions, 'secureContext' | 'secureProtocol'>;

type SerializedSessionOption = [string] | [string, unknown];

const maxProtocolCacheSize = 100;
const protocolCache = new Map<string, string | false>();
const referenceIds = new WeakMap<object, number>();
let nextReferenceId = 0;
const connectionSpecificHeaders = new Set([
	'connection',
	'http2-settings',
	'keep-alive',
	'proxy-connection',
	'transfer-encoding',
	'upgrade',
]);

const normalizeRequestHeaderName = (name: string): string => name.toLowerCase() === 'host' ? HTTP2_HEADER_AUTHORITY : name.toLowerCase();

const getConnectionHeaderTokens = (value: string | string[] | number | undefined): string[] => {
	if (value === undefined) {
		return [];
	}

	const values = Array.isArray(value) ? value : [value];
	const tokens: string[] = [];

	for (const item of values) {
		for (const token of String(item).split(',')) {
			const normalizedToken = token.trim().toLowerCase();

			if (normalizedToken.length > 0) {
				tokens.push(normalizedToken);
			}
		}
	}

	return tokens;
};

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

const getReferenceId = (value: object): number => {
	let referenceId = referenceIds.get(value);

	if (referenceId === undefined) {
		referenceId = nextReferenceId++;
		referenceIds.set(value, referenceId);
	}

	return referenceId;
};

const isPlainObject = (value: object): value is Record<string, unknown> => {
	const prototype = Object.getPrototypeOf(value);

	return prototype === Object.prototype || prototype === null;
};

const serializeSessionOption = (value: unknown): SerializedSessionOption => {
	if (value === undefined) {
		return ['undefined'];
	}

	if (value === null) {
		return ['null'];
	}

	if (typeof value === 'function') {
		return ['function', getReferenceId(value)];
	}

	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return [typeof value, value];
	}

	if (typeof value === 'bigint') {
		return ['bigint', value.toString()];
	}

	if (typeof value === 'symbol') {
		return ['symbol', value.description];
	}

	if (Array.isArray(value)) {
		return ['array', value.map(item => serializeSessionOption(item))];
	}

	if (typeof value === 'object') {
		if (ArrayBuffer.isView(value)) {
			return ['bytes', Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')];
		}

		if (isPlainObject(value)) {
			return ['object', Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, serializeSessionOption(item)])];
		}

		return ['object-reference', getReferenceId(value)];
	}

	return [typeof value];
};

const serializeSessionOptions = (values: unknown[]): string => JSON.stringify(values.map(value => serializeSessionOption(value)));

const getTlsSessionOptions = (options: TlsSessionIdentityOptions): unknown[] => [
	options.ca,
	options.cert,
	options.key,
	options.pfx,
	options.rejectUnauthorized,
	options.servername,
	options.localAddress,
	options.lookup,
	options.family,
	options.minVersion,
	options.maxVersion,
	options.ciphers,
	options.honorCipherOrder,
	options.checkServerIdentity,
	options.passphrase,
	options.sigalgs,
	options.sessionTimeout,
	options.dhparam,
	options.ecdhCurve,
	options.crl,
	options.secureOptions,
	options.secureContext,
	options.secureProtocol,
];

const destroyReuseSocket = (options: NormalizedRequestOptions): void => {
	options._reuseSocket?.destroy();
	delete options._reuseSocket;
	delete options._reuseSocketShouldPool;
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
	const protocols = ((options as NormalizedRequestOptions).ALPNProtocols ?? ['h2', 'http/1.1']).join(',');

	return serializeSessionOptions([
		authority.host,
		protocols,
		...getTlsSessionOptions(options),
	]);
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
		_reuseSocketShouldPool,
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

const filterRawHeaders = (rawHeaders: string[]): string[] => {
	const filteredHeaders: string[] = [];

	for (let index = 0; index < rawHeaders.length; index += 2) {
		const key = rawHeaders[index]!;

		if (key.startsWith(':')) {
			continue;
		}

		filteredHeaders.push(key, rawHeaders[index + 1]!);
	}

	return filteredHeaders;
};

const filterHeaders = (headers: http2.IncomingHttpHeaders): IncomingMessage['headers'] => {
	const filteredHeaders: IncomingMessage['headers'] = {};

	for (const [key, value] of Object.entries(headers)) {
		if (key.startsWith(':') || value === undefined) {
			continue;
		}

		filteredHeaders[key] = value;
	}

	return filteredHeaders;
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
	readonly pendingSessionKeys = new Set<string>();
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

	async request(origin: URL, options: NormalizedRequestOptions, headers: RequestHeaders, streamOptions?: http2.ClientSessionRequestOptions): Promise<AgentRequestResult> {
		const {session, reusedSocket} = await this.getSessionWithMetadata(origin, options, true);

		return {
			stream: session.request(headers, streamOptions),
			reusedSocket,
		};
	}

	async getSession(origin: string | URL, options: NormalizedRequestOptions = {}): Promise<Http2Session> {
		const {session} = await this.getSessionWithMetadata(origin, options);
		return session;
	}

	private async getSessionWithMetadata(origin: string | URL, options: NormalizedRequestOptions = {}, reserveStream = false): Promise<AgentSessionResult> {
		const normalizedOrigin = typeof origin === 'string' ? new URL(origin) : origin;
		const key = this.normalizeOptions(normalizedOrigin, options);
		const canUsePooledSession = options._reuseSocket === undefined || options._reuseSocketShouldPool === true;
		const session = canUsePooledSession ? this.getAvailableSession(key) : undefined;

		if (session) {
			if (reserveStream) {
				this.reserveStream(session);
			}

			destroyReuseSocket(options);

			return {
				session,
				reusedSocket: true,
			};
		}

		return new Promise((resolve, reject) => {
			const entry: QueueEntry = {
				origin: normalizedOrigin,
				options,
				reserveStream,
				resolve,
				reject,
			};

			options._cancelSessionSetup = () => {
				const index = this.queue.indexOf(entry);

				if (index !== -1) {
					this.queue.splice(index, 1);
					delete options._cancelSessionSetup;
					destroyReuseSocket(options);
					reject(new Error('HTTP/2 session setup canceled'));
				}
			};

			this.queue.push(entry);

			this.processQueue();
		});
	}

	normalizeOptions(origin: URL, options: NormalizedRequestOptions = {}): string {
		return serializeSessionOptions([
			origin.origin,
			...getTlsSessionOptions(options),
		]);
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
		this.pendingSessionKeys.clear();

		while (this.queue.length > 0) {
			const entry = this.queue.shift()!;
			delete entry.options._cancelSessionSetup;
			destroyReuseSocket(entry.options);
			entry.reject(reason ?? new Error('Agent has been destroyed'));
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
		let index = 0;

		while (index < this.queue.length) {
			const entry = this.queue[index]!;
			const key = this.normalizeOptions(entry.origin, entry.options);
			const canUsePooledSession = entry.options._reuseSocket === undefined || entry.options._reuseSocketShouldPool === true;
			const session = canUsePooledSession ? this.getAvailableSession(key) : undefined;

			if (session) {
				this.queue.splice(index, 1);
				delete entry.options._cancelSessionSetup;
				if (entry.reserveStream) {
					this.reserveStream(session);
				}

				destroyReuseSocket(entry.options);
				entry.resolve({
					session,
					reusedSocket: true,
				});
				continue;
			}

			if (canUsePooledSession && this.pendingSessionKeys.has(key)) {
				index++;
				continue;
			}

			if (this.sessionCount >= this.maxSessions) {
				this.closeEmptySessions(this.sessionCount - this.maxSessions + 1);

				if (this.sessionCount >= this.maxSessions) {
					index++;
					continue;
				}
			}

			this.queue.splice(index, 1);
			if (canUsePooledSession) {
				this.pendingSessionKeys.add(key);
			}

			this.createSession(entry, key);
		}
	}

	private reserveStream(session: Http2Session): void {
		session.ref();

		if (session.currentStreamCount === 0 && session.emptySessionCounted) {
			this.emptySessionCount--;
			session.emptySessionCounted = false;
		}

		session.currentStreamCount = (session.currentStreamCount ?? 0) + 1;
		session.reservedStreamCount = (session.reservedStreamCount ?? 0) + 1;
	}

	private releaseStream(session: Http2Session, shouldPoolSession: boolean): void {
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
	}

	private createSession(entry: QueueEntry, key: string): void {
		this.sessionCount++;
		const {
			path: _path,
			agent: _agent,
			h2session: _h2session,
			_reuseSocketShouldPool,
			timeout: setupTimeout,
			...sessionOptions
		} = entry.options;

		const options: NormalizedRequestOptions = {
			...sessionOptions,
			settings: entry.options.settings ?? this.settings,
			ALPNProtocols: ['h2'],
		};

		const shouldPoolSession = options._reuseSocket === undefined || _reuseSocketShouldPool === true;
		if (options._reuseSocket) {
			const socket = options._reuseSocket;
			options.createConnection = () => socket;
			delete options._reuseSocket;
		}

		const session = http2.connect(entry.origin, options as http2.SecureClientSessionOptions) as Http2Session;
		session.currentStreamCount = 0;
		session.reservedStreamCount = 0;
		session.emptySessionCounted = false;
		session.gracefullyClosing = false;
		let settled = false;
		let sessionSetupTimeout: NodeJS.Timeout | undefined;

		const clearSessionSetupTimeout = () => {
			if (sessionSetupTimeout) {
				clearTimeout(sessionSetupTimeout);
				sessionSetupTimeout = undefined;
			}
		};

		const clearSessionSetup = () => {
			clearSessionSetupTimeout();
			this.pendingSessionKeys.delete(key);
			delete entry.options._cancelSessionSetup;
		};

		if (this.timeout > 0) {
			session.setTimeout(this.timeout, () => {
				session.destroy();
			});
		}

		if (setupTimeout !== undefined) {
			sessionSetupTimeout = setTimeout(() => {
				if (settled) {
					return;
				}

				settled = true;
				clearSessionSetup();
				const error = new TimeoutError(Number(setupTimeout), 'request');
				entry.reject(error);
				queueMicrotask(() => {
					session.destroy(error);
				});
			}, Number(setupTimeout));
			sessionSetupTimeout.unref();
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
			if (settled) {
				return;
			}

			settled = true;
			clearSessionSetup();

			if (shouldPoolSession) {
				const sessions = this.sessions.get(key) ?? [];
				sessions.push(session);
				this.sessions.set(key, sessions);
			}

			this.emit('session', session);
			if (entry.reserveStream) {
				this.reserveStream(session);
			}

			entry.resolve({
				session,
				reusedSocket: false,
			});

			this.processQueue();
		});

		session.once('error', error => {
			clearSessionSetup();
			if (!settled) {
				settled = true;
				entry.reject(error);
			}

			removeSession();
		});

		session.once('goaway', () => {
			session.gracefullyClosing = true;

			if (session.currentStreamCount === 0) {
				session.close();
			}
		});

		session.once('close', () => {
			clearSessionSetup();
			this.sessionCount--;
			if (!settled) {
				settled = true;
				entry.reject(new Error('The HTTP/2 session closed before settings were received'));
			}

			removeSession();
			this.processQueue();
		});

		entry.options._cancelSessionSetup = () => {
			if (settled) {
				return;
			}

			settled = true;
			clearSessionSetup();
			entry.reject(new Error('HTTP/2 session setup canceled'));
			session.destroy();
		};

		const request = session.request.bind(session);
		session.request = (headers, streamOptions) => {
			const hasReservedStream = (session.reservedStreamCount ?? 0) > 0;

			if (hasReservedStream) {
				session.reservedStreamCount = session.reservedStreamCount! - 1;
			}

			if (session.gracefullyClosing) {
				if (hasReservedStream) {
					this.releaseStream(session, shouldPoolSession);
				}

				throw new Error('The session is gracefully closing. No new streams are allowed.');
			}

			if (!hasReservedStream) {
				this.reserveStream(session);
			}

			let stream: ClientHttp2Stream;
			try {
				stream = request(headers, streamOptions);
			} catch (error: unknown) {
				this.releaseStream(session, shouldPoolSession);
				throw error;
			}

			stream.once('close', () => {
				this.releaseStream(session, shouldPoolSession);
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
	}

	agent?: Http2Agent;
	aborted = false;
	reusedSocket = false;
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
	private pendingAgentPromise?: Promise<AgentRequestResult>;
	private readonly connectionHeaderNames = new Set<string>();
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
			this.stream.close(NGHTTP2_CANCEL);
		} else {
			this.options._cancelSessionSetup?.();

			if (error === null) {
				queueMicrotask(() => {
					this.emit('close');
				});
			}
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
				this.reusedSocket = true;
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
			const {stream, reusedSocket} = await streamPromise;
			this.reusedSocket = reusedSocket;
			this.onStream(stream);
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

		if (lowercasedName === 'connection' || lowercasedName === 'proxy-connection') {
			for (const token of getConnectionHeaderTokens(value)) {
				this.connectionHeaderNames.add(token);
				Reflect.deleteProperty(this.headers, normalizeRequestHeaderName(token));
			}

			return this;
		}

		if (connectionSpecificHeaders.has(lowercasedName)) {
			return this;
		}

		if (this.connectionHeaderNames.has(lowercasedName)) {
			return this;
		}

		if (lowercasedName === 'te' && !isTrailersTeHeader(value)) {
			return this;
		}

		this.headers[normalizeRequestHeaderName(name)] = value;

		return this;
	}

	getHeader(name: string): string | number | string[] | undefined {
		return this.headers[normalizeRequestHeaderName(name)];
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

		Reflect.deleteProperty(this.headers, normalizeRequestHeaderName(name));
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
			response.headers = filterHeaders(headers);
			response.rawHeaders = rawHeaders ? filterRawHeaders(rawHeaders) : toRawHeaders(headers);
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
	input: string | URL | NormalizedRequestOptions,
	options?: NormalizedRequestOptions | RequestCallback,
	callback?: RequestCallback,
): ClientRequest => new Http2ClientRequest(input, options, callback) as unknown as ClientRequest;

const getSourceOptions = (
	input: string | URL | NormalizedRequestOptions,
	options?: NormalizedRequestOptions | RequestCallback,
): NormalizedRequestOptions => {
	if (typeof input === 'object' && !(input instanceof URL)) {
		return input;
	}

	return typeof options === 'object' ? options : {};
};

const requestHttp1 = (options: NormalizedRequestOptions, agent: AgentObject | HttpsAgent | Http2Agent | false | undefined, callback?: RequestCallback): ClientRequest => {
	if (typeof agent === 'object' && 'https' in agent) {
		options.agent = agent.https;
	}

	delete options.timeout;

	if (options.headers) {
		const headers: Record<string, any> = {...options.headers};
		Reflect.deleteProperty(headers, HTTP2_HEADER_METHOD);
		Reflect.deleteProperty(headers, HTTP2_HEADER_SCHEME);
		Reflect.deleteProperty(headers, HTTP2_HEADER_PATH);

		if (headers[HTTP2_HEADER_AUTHORITY] && !headers.host) {
			headers.host = headers[HTTP2_HEADER_AUTHORITY];
		}

		Reflect.deleteProperty(headers, HTTP2_HEADER_AUTHORITY);
		options.headers = headers;
	}

	return https.request(options as HttpsRequestOptions, callback);
};

const requestWithCustomHttpsAgent = (options: NormalizedRequestOptions, agent: AgentObject & {https: HttpsAgent}, callback?: RequestCallback): ClientRequest => {
	options.agent = agent.https;
	options.ALPNProtocols = ['http/1.1'];
	delete options.timeout;

	return https.request(options as HttpsRequestOptions, callback);
};

const requestHttp2 = (options: NormalizedRequestOptions, agent: AgentObject | HttpsAgent | Http2Agent | false | undefined, socket: Socket | undefined, callback?: RequestCallback): ClientRequest => {
	options.agent = typeof agent === 'object' && 'http2' in agent ? agent.http2 : agent as Http2Agent | false | undefined;

	if (socket) {
		options._reuseSocket = socket;
		options._reuseSocketShouldPool = options.createConnection === undefined;
	}

	return request(options, callback);
};

export const auto = async (
	input: string | URL | NormalizedRequestOptions,
	options?: NormalizedRequestOptions | RequestCallback,
	callback?: RequestCallback,
): Promise<ClientRequest> => {
	const sourceOptions = getSourceOptions(input, options);
	const normalized = normalizeInput(input, options, callback);
	options = normalized.options;
	callback = normalized.callback;
	options.ALPNProtocols ??= ['h2', 'http/1.1'];
	options.protocol ??= 'https:';

	if (options.h2session) {
		return request(options, callback);
	}

	const isHttps = options.protocol === 'https:';

	if (!isHttps) {
		options.agent = (options.agent as AgentObject | undefined)?.http;
		return http.request(options as http.RequestOptions, callback);
	}

	const agent = options.agent as AgentObject | HttpsAgent | Http2Agent | false | undefined;
	if (hasCustomHttpsAgent(agent) && options.createConnection === undefined) {
		return requestWithCustomHttpsAgent(options, agent, callback);
	}

	const {alpnProtocol, socket} = await resolveProtocol(options, sourceOptions);
	if (alpnProtocol === 'h2') {
		return requestHttp2(options, agent, socket, callback);
	}

	socket?.destroy();
	return requestHttp1(options, agent, callback);
};

const http2Client = {
	Agent: Http2Agent,
	auto,
	globalAgent,
	request,
};

export default http2Client;
