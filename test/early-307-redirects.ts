import {Buffer} from 'node:buffer';
import {Agent as HttpAgent, request as httpRequest, type ClientRequest} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import type {Handler} from 'express';
import withServer from './helpers/with-server.js';

const early307RedirectHandler = (location: string): Handler => (request, response) => {
	let redirected = false;

	request.on('error', () => {});
	request.on('data', () => {
		if (redirected) {
			return;
		}

		redirected = true;
		response.writeHead(307, {
			location,
		});
		response.end();
	});

	request.resume();
};

/*
Intercepts write callbacks on a request and delays them until after the response event, then calls them with the injected error. This simulates a delayed write error (EPIPE, ECONNRESET, etc.) arriving after the server has already sent a response.
*/
const injectWriteErrorAfterResponse = (request: ClientRequest, writeError: NodeJS.ErrnoException, onInjected?: () => void): void => {
	let responseReceived = false;
	let errorInjected = false;
	const pendingCallbacks: Array<(error: Error | undefined) => void> = [];
	const originalWrite = request.write.bind(request);

	const flushPendingWithError = () => {
		errorInjected = true;
		onInjected?.();

		const callbacks = [...pendingCallbacks];
		pendingCallbacks.length = 0;

		setTimeout(() => {
			for (const callback of callbacks) {
				callback(writeError);
			}
		}, 0);
	};

	request.once('response', () => {
		responseReceived = true;
		if (!errorInjected) {
			flushPendingWithError();
		}
	});

	// eslint-disable-next-line @typescript-eslint/no-restricted-types
	const wrapCallback = (callback: (error: Error | null | undefined) => void): (error: Error | null | undefined) => void =>
		error => {
			// After injection, pass through errors as-is.
			if (errorInjected) {
				callback(error);
				return;
			}

			// If the real write errored, forward it immediately.
			if (error !== undefined && error !== null) {
				callback(error);
				return;
			}

			// If response already arrived, inject the error now.
			if (responseReceived) {
				flushPendingWithError();
				callback(writeError);
				return;
			}

			// Queue the callback to be flushed with the injected error when the response arrives.
			pendingCallbacks.push(callback);
		};

	// eslint-disable-next-line @typescript-eslint/no-restricted-types
	request.write = ((chunk: any, encoding: BufferEncoding | undefined, callback?: (error: Error | null | undefined) => void) => {
		if (typeof encoding === 'function') {
			callback = encoding;
			encoding = undefined;
		}

		if (typeof callback !== 'function') {
			return encoding === undefined ? originalWrite(chunk) : originalWrite(chunk, encoding);
		}

		return encoding === undefined
			? originalWrite(chunk, wrapCallback(callback))
			: originalWrite(chunk, encoding, wrapCallback(callback));
	}) as typeof request.write;
};

/*
Injects a transient write callback error before the request receives a response.

This simulates the race where chunk writing fails before redirect handling marks the original request stale.
*/
const injectWriteErrorBeforeResponse = (request: ClientRequest, writeError: NodeJS.ErrnoException, onInjected?: () => void): void => {
	let injected = false;
	const originalWrite = request.write.bind(request);

	// eslint-disable-next-line @typescript-eslint/no-restricted-types
	request.write = ((chunk: any, encoding: BufferEncoding | undefined, callback?: (error: Error | null | undefined) => void) => {
		if (typeof encoding === 'function') {
			callback = encoding;
			encoding = undefined;
		}

		if (!injected && typeof callback === 'function') {
			injected = true;
			const result = encoding === undefined ? originalWrite(chunk) : originalWrite(chunk, encoding);
			onInjected?.();
			callback(writeError);
			return result;
		}

		if (encoding === undefined) {
			return callback ? originalWrite(chunk, callback) : originalWrite(chunk);
		}

		return callback ? originalWrite(chunk, encoding, callback) : originalWrite(chunk, encoding);
	}) as typeof request.write;
};

test('large body is preserved on early 307 redirect', withServer, async (t, server, got) => {
	const requestBody = Buffer.alloc(1024 * 1024 * 4, 'b');
	const agent = new HttpAgent({
		keepAlive: true,
		maxSockets: 1,
	});
	const requests: ClientRequest[] = [];

	server.post('/redirect-early', early307RedirectHandler('/target-early'));

	server.post('/target-early', async (request, response) => {
		const receivedChunks: Uint8Array[] = [];

		for await (const receivedChunk of request) {
			receivedChunks.push(Buffer.from(receivedChunk));
		}

		const receivedBody = Buffer.concat(receivedChunks);

		t.true(receivedBody.equals(requestBody));
		response.end('ok');
	});

	try {
		const {body} = await got.post('redirect-early', {
			body: requestBody,
			retry: {
				limit: 0,
			},
			agent: {
				http: agent,
			},
		}).on('request', request => {
			requests.push(request);
		});

		t.is(body, 'ok');
		t.is(requests.length, 2);

		const staleRequest = requests[0];
		if (!staleRequest) {
			throw new Error('Expected a stale redirected request');
		}

		if (!staleRequest.destroyed && !staleRequest.writableEnded) {
			await Promise.race([
				new Promise<void>(resolve => {
					staleRequest.once('finish', resolve);
					staleRequest.once('close', resolve);
				}),
				(async () => {
					await delay(1000);
					throw new Error('Stale redirected request was not finalized');
				})(),
			]);
		}

		t.true(staleRequest.destroyed || staleRequest.writableEnded);
	} finally {
		agent.destroy();
	}
});

test('early 307 redirect emits final upload progress event', withServer, async (t, server, got) => {
	const requestBody = Buffer.alloc(1024 * 1024 * 4, 'c');
	const events: Array<{percent: number; transferred: number; total?: number}> = [];

	server.post('/redirect-early-progress', early307RedirectHandler('/target-early-progress'));

	server.post('/target-early-progress', async (request, response) => {
		for await (const receivedChunk of request) {
			void receivedChunk;
		}

		response.end('ok');
	});

	const {body} = await got.post('redirect-early-progress', {
		body: requestBody,
		retry: {
			limit: 0,
		},
	}).on('uploadProgress', event => {
		events.push({
			percent: event.percent,
			transferred: event.transferred,
			total: event.total,
		});
	});

	t.is(body, 'ok');
	t.true(events.length > 1);

	const finalEvent = events.at(-1);
	t.truthy(finalEvent);
	t.is(finalEvent?.percent, 1);
	t.is(finalEvent?.transferred, requestBody.byteLength);
	t.is(finalEvent?.total, requestBody.byteLength);
});

test('early 307 redirect emits final upload progress event for small body', withServer, async (t, server, got) => {
	const requestBody = Buffer.alloc(32, 'd');
	const events: Array<{percent: number; transferred: number; total?: number}> = [];

	server.post('/redirect-early-progress-small', early307RedirectHandler('/target-early-progress-small'));

	server.post('/target-early-progress-small', async (request, response) => {
		for await (const receivedChunk of request) {
			void receivedChunk;
		}

		response.end('ok');
	});

	const {body} = await got.post('redirect-early-progress-small', {
		body: requestBody,
		retry: {
			limit: 0,
		},
	}).on('uploadProgress', event => {
		events.push({
			percent: event.percent,
			transferred: event.transferred,
			total: event.total,
		});
	});

	t.is(body, 'ok');
	t.true(events.length > 1);

	const finalEvent = events.at(-1);
	t.truthy(finalEvent);
	t.is(finalEvent?.percent, 1);
	t.is(finalEvent?.transferred, requestBody.byteLength);
	t.is(finalEvent?.total, requestBody.byteLength);
});

test('early 307 redirect preserves upload progress totals', withServer, async (t, server, got) => {
	const requestBody = Buffer.alloc(1024 * 1024 * 4, 'e');
	const events: Array<{percent: number; transferred: number; total: number | undefined}> = [];
	const requestMethods: string[] = [];

	server.post('/redirect-early-progress-preserve', early307RedirectHandler('/target-early-progress-preserve'));

	server.post('/target-early-progress-preserve', async (request, response) => {
		for await (const receivedChunk of request) {
			void receivedChunk;
		}

		response.end('ok');
	});

	const {body} = await got.post('redirect-early-progress-preserve', {
		body: requestBody,
		retry: {
			limit: 0,
		},
	}).on('request', request => {
		requestMethods.push(request.method ?? '');
	}).on('uploadProgress', event => {
		events.push({
			percent: event.percent,
			transferred: event.transferred,
			total: event.total,
		});
	});

	t.is(body, 'ok');
	t.deepEqual(requestMethods, ['POST', 'POST']);

	let redirectedStartEventIndex = -1;
	for (let index = events.length - 1; index >= 0; index--) {
		if (events[index]!.transferred === 0) {
			redirectedStartEventIndex = index;
			break;
		}
	}

	t.true(redirectedStartEventIndex >= 0);

	const redirectedStartEvent = events[redirectedStartEventIndex]!;
	t.is(redirectedStartEvent.total, requestBody.byteLength);

	const redirectedProgressEvents = events.slice(redirectedStartEventIndex + 1).filter(event => event.transferred > 0 && event.transferred < requestBody.byteLength);
	t.true(redirectedProgressEvents.length > 0);

	for (const event of redirectedProgressEvents) {
		t.is(event.total, requestBody.byteLength);
		t.true(event.percent > 0);
		t.true(event.percent < 1);
	}
});

test('early 307 redirect finalizes writable side for buffered body', withServer, async (t, server, got) => {
	const requestBody = Buffer.alloc(1024 * 1024 * 4, 'f');

	server.post('/redirect-early-writable-finish', early307RedirectHandler('/target-early-writable-finish'));

	server.post('/target-early-writable-finish', async (request, response) => {
		for await (const receivedChunk of request) {
			void receivedChunk;
		}

		response.end('ok');
	});

	const requestStream = got.stream.post('redirect-early-writable-finish', {
		body: requestBody,
		retry: {
			limit: 0,
		},
	});

	let finished = false;
	requestStream.once('finish', () => {
		finished = true;
	});

	let responseBody = '';
	for await (const chunk of requestStream) {
		responseBody += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
	}

	if (!finished) {
		await Promise.race([
			new Promise<void>(resolve => {
				requestStream.once('finish', resolve);
			}),
			(async () => {
				await delay(1000);
				throw new Error('Redirected buffered stream did not emit finish');
			})(),
		]);
	}

	t.is(responseBody, 'ok');
	t.true(requestStream.writableFinished);
});

test('early 307 redirect finalizes writable side when transient chunk write callback errors before stale mark', withServer, async (t, server, got) => {
	const requestBody = Buffer.alloc(1024 * 1024 * 4, 'l');
	const requests: ClientRequest[] = [];
	const writeError = new Error('write EPIPE') as NodeJS.ErrnoException;
	let isFirstRequest = true;
	let injectedError = false;
	writeError.code = 'EPIPE';

	server.post('/redirect-early-transient-finish', early307RedirectHandler('/target-early-transient-finish'));

	server.post('/target-early-transient-finish', async (request, response) => {
		for await (const receivedChunk of request) {
			void receivedChunk;
		}

		response.end('ok');
	});

	const requestFunction = (...arguments_: Parameters<typeof httpRequest>): ClientRequest => {
		const request = httpRequest(...arguments_);
		requests.push(request);

		if (isFirstRequest) {
			isFirstRequest = false;
			injectWriteErrorBeforeResponse(request, writeError, () => {
				injectedError = true;
			});
		}

		return request;
	};

	const requestStream = got.stream.post('redirect-early-transient-finish', {
		body: requestBody,
		retry: {
			limit: 0,
		},
		request: requestFunction,
	});

	let responseBody = '';
	for await (const responseChunk of requestStream) {
		responseBody += Buffer.isBuffer(responseChunk) ? responseChunk.toString() : String(responseChunk);
	}

	if (!requestStream.writableFinished) {
		await Promise.race([
			new Promise<void>(resolve => {
				requestStream.once('finish', resolve);
			}),
			(async () => {
				await delay(1000);
				throw new Error('Redirected buffered stream did not emit finish after transient write callback error');
			})(),
		]);
	}

	t.is(responseBody, 'ok');
	t.true(injectedError);
	t.is(requests.length, 2);
	t.true(requestStream.writableFinished);
});

test('early 307 redirect does not prematurely end redirected request while replaying body', withServer, async (t, server, got) => {
	const requestBody = Buffer.alloc(1024 * 1024 * 4, 'g');
	let redirectedRequestAborted = false;
	let redirectedBodyLength = 0;

	server.post('/redirect-early-race', early307RedirectHandler('/target-early-race'));

	server.post('/target-early-race', async (request, response) => {
		request.on('aborted', () => {
			redirectedRequestAborted = true;
		});

		const receivedChunks: Uint8Array[] = [];
		for await (const receivedChunk of request) {
			receivedChunks.push(Buffer.from(receivedChunk));
		}

		redirectedBodyLength = Buffer.concat(receivedChunks).byteLength;
		response.end('ok');
	});

	const {body} = await got.post('redirect-early-race', {
		body: requestBody,
		retry: {
			limit: 0,
		},
	}).on('request', request => {
		const originalWrite = request.write.bind(request);

		request.write = ((chunk: any, encoding?: any, callback?: any) => {
			if (typeof encoding === 'function') {
				callback = encoding;
				encoding = undefined;
			}

			if (typeof callback === 'function') {
				const originalCallback = callback;
				callback = (error?: Error) => {
					setTimeout(() => {
						originalCallback(error);
					}, 25);
				};
			}

			return originalWrite(chunk, encoding, callback);
		}) as typeof request.write;
	});

	t.is(body, 'ok');
	t.false(redirectedRequestAborted);
	t.is(redirectedBodyLength, requestBody.byteLength);
});

test('early 307 redirect preserves body when beforeRedirect hook is delayed', withServer, async (t, server, got) => {
	const requestBody = Buffer.alloc(1024 * 1024 * 2, 'h');

	server.post('/redirect-early-delayed-before-redirect', early307RedirectHandler('/target-early-delayed-before-redirect'));

	server.post('/target-early-delayed-before-redirect', async (request, response) => {
		const receivedChunks: Uint8Array[] = [];
		for await (const receivedChunk of request) {
			receivedChunks.push(Buffer.from(receivedChunk));
		}

		const receivedBody = Buffer.concat(receivedChunks);
		t.true(receivedBody.equals(requestBody));
		response.end('ok');
	});

	const {body} = await got.post('redirect-early-delayed-before-redirect', {
		body: requestBody,
		retry: {
			limit: 0,
		},
		hooks: {
			beforeRedirect: [
				async () => {
					await delay(50);
				},
			],
		},
	});

	t.is(body, 'ok');
});

test('early 307 redirect does not emit stale original request write error', withServer, async (t, server, got) => {
	const requestBody = Buffer.alloc(1024 * 1024 * 2, 'i');
	const requestErrors: Error[] = [];
	const requests: ClientRequest[] = [];

	server.post('/redirect-early-stale-error', early307RedirectHandler('/target-early-stale-error'));

	server.post('/target-early-stale-error', async (request, response) => {
		for await (const receivedChunk of request) {
			void receivedChunk;
		}

		response.end('ok');
	});

	const {body} = await got.post('redirect-early-stale-error', {
		body: requestBody,
		retry: {
			limit: 0,
		},
	}).on('request', request => {
		requests.push(request);
		request.once('error', error => {
			requestErrors.push(error);
		});
	});

	t.is(body, 'ok');
	t.is(requests.length, 2);

	const originalRequest = requests[0];
	t.truthy(originalRequest);
	t.false(requestErrors.some(error => {
		const {code} = error as NodeJS.ErrnoException;
		return code === 'EPIPE' || code === 'ECONNRESET' || code === 'ECANCELED';
	}));
});

const staleWriteErrorCases = [
	{
		name: 'EPIPE',
		code: 'EPIPE',
		redirectPath: '/redirect-early-injected-transient',
		targetPath: '/target-early-injected-transient',
	},
	{
		name: 'ECONNRESET',
		code: 'ECONNRESET',
		redirectPath: '/redirect-early-injected-connreset',
		targetPath: '/target-early-injected-connreset',
	},
	{
		name: 'non-transient',
		code: 'EACCES',
		redirectPath: '/redirect-early-injected-non-transient',
		targetPath: '/target-early-injected-non-transient',
	},
] as const;

for (const staleWriteErrorCase of staleWriteErrorCases) {
	test(`early 307 redirect ignores delayed stale ${staleWriteErrorCase.name} write error`, withServer, async (t, server, got) => {
		const requestBody = Buffer.alloc(1024 * 1024 * 2, 'k');
		const requests: ClientRequest[] = [];
		const requestErrors: Error[] = [];
		let injectedError = false;

		server.post(staleWriteErrorCase.redirectPath, early307RedirectHandler(staleWriteErrorCase.targetPath));

		server.post(staleWriteErrorCase.targetPath, async (request, response) => {
			for await (const receivedChunk of request) {
				void receivedChunk;
			}

			response.end('ok');
		});

		const staleError = new Error('stale request write error') as NodeJS.ErrnoException;
		staleError.code = staleWriteErrorCase.code;

		const {body} = await got.post(staleWriteErrorCase.redirectPath.slice(1), {
			body: requestBody,
			retry: {
				limit: 0,
			},
		}).on('request', request => {
			requests.push(request);

			request.on('error', error => {
				requestErrors.push(error);
			});

			if (requests.length === 1) {
				injectWriteErrorAfterResponse(request, staleError, () => {
					injectedError = true;
				});
			}
		});

		t.is(body, 'ok');
		t.is(requests.length, 2);
		t.true(injectedError);
		t.is(requestErrors.length, 0);
	});
}

test('early 307 redirect final upload progress remains complete with delayed beforeRedirect', withServer, async (t, server, got) => {
	const requestBody = Buffer.alloc(1024 * 1024 * 2, 'j');
	const events: Array<{percent: number; transferred: number; total?: number}> = [];

	server.post('/redirect-early-progress-delayed-before-redirect', early307RedirectHandler('/target-early-progress-delayed-before-redirect'));

	server.post('/target-early-progress-delayed-before-redirect', async (request, response) => {
		for await (const receivedChunk of request) {
			void receivedChunk;
		}

		response.end('ok');
	});

	const {body} = await got.post('redirect-early-progress-delayed-before-redirect', {
		body: requestBody,
		retry: {
			limit: 0,
		},
		hooks: {
			beforeRedirect: [
				async () => {
					await delay(50);
				},
			],
		},
	}).on('uploadProgress', event => {
		events.push({
			percent: event.percent,
			transferred: event.transferred,
			total: event.total,
		});
	});

	t.is(body, 'ok');
	t.true(events.length > 1);

	const finalEvent = events.at(-1);
	t.truthy(finalEvent);
	t.is(finalEvent?.percent, 1);
	t.is(finalEvent?.transferred, requestBody.byteLength);
	t.is(finalEvent?.total, requestBody.byteLength);
});
