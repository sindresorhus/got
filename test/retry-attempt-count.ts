import test from 'ava';
import {type HTTPError, type RequestError, RetryError} from '../source/index.js';
import withServer from './helpers/with-server.js';

test('the first manual retry gets attemptCount 1', withServer, async (t, server, got) => {
	const attemptCounts: number[] = [];

	server.get('/', (request, response) => {
		if (request.url === '/?done=true') {
			response.end('done');
			return;
		}

		response.end('retry');
	});

	const response = await got('', {
		retry: {
			calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				return attemptCount * 10;
			},
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.body === 'retry') {
						return retryWithMergedOptions({searchParams: {done: 'true'}});
					}

					return response;
				},
			],
		},
	}).text();

	t.is(response, 'done');
	t.deepEqual(attemptCounts, [1]);
});

test('manual retries count up like ordinary retries', withServer, async (t, server, got) => {
	const attemptCounts: number[] = [];
	let requestCount = 0;

	server.get('/', (request, response) => {
		requestCount++;
		if (requestCount >= 5 || request.url === '/?attempt=4') {
			response.end('done');
			return;
		}

		response.end('retry');
	});

	const response = await got('', {
		retry: {
			limit: 4,
			calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				return attemptCount;
			},
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.body === 'retry') {
						const attemptCount = attemptCounts.at(-1) ?? 0;
						// Preserve the hook to request each subsequent retry until attempt=4.
						return retryWithMergedOptions({searchParams: {attempt: attemptCount + 1}, preserveHooks: true});
					}

					return response;
				},
			],
		},
	}).text();

	t.is(response, 'done');
	t.deepEqual(attemptCounts, [1, 2, 3, 4]);
});

test('the first ordinary retry gets attemptCount 1', withServer, async (t, server, got) => {
	let requestCount = 0;
	const attemptCounts: number[] = [];

	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === 1) {
			response.destroy();
			return;
		}

		response.end('done');
	});

	const response = await got('', {
		retry: {
			calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				return attemptCount;
			},
		},
	}).text();

	t.is(response, 'done');
	t.deepEqual(attemptCounts, [1]);
});

test('automatic and manual retries share one ascending count', withServer, async (t, server, got) => {
	const attemptCounts: number[] = [];
	let requestCount = 0;

	server.get('/', (_request, response) => {
		requestCount++;
		if (requestCount >= 3) {
			response.end('done');
			return;
		}

		response.statusCode = 503;
		response.end('unavailable');
	});

	const response = await got('', {
		retry: {
			limit: 1,
			calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				return attemptCount;
			},
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 503 && response.retryCount === 1) {
						// The automatic retry already consumed the last attempt budget slot, so the next retry must be manual.
						return retryWithMergedOptions({headers: {'x-manual': 'true'}});
					}

					return response;
				},
			],
		},
	}).text();

	t.is(response, 'done');
	t.deepEqual(attemptCounts, [1, 2]);
	t.is(requestCount, 3);
});

test('a zero delay from calculateDelay aborts a manual retry', withServer, async (t, server, got) => {
	const attemptCounts: number[] = [];
	let requestCount = 0;

	server.get('/', (_request, response) => {
		requestCount++;
		response.end('body');
	});

	const error = await t.throwsAsync<RetryError>(got('', {
		retry: {
			calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				return 0;
			},
		},
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({}),
			],
		},
	}), {instanceOf: RetryError});

	t.is(error.name, 'RetryError');
	t.deepEqual(attemptCounts, [1]);
	t.is(requestCount, 1);
});

test('a thrown delay aborts a manual retry with the thrown error', withServer, async (t, server, got) => {
	let requestCount = 0;

	server.get('/', (_request, response) => {
		requestCount++;
		response.end('body');
	});

	const error = await t.throwsAsync<RequestError>(got('', {
		retry: {
			calculateDelay() {
				throw new Error('delay boom');
			},
		},
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({}),
			],
		},
	}));

	t.is(error.message, 'delay boom');
	t.is(requestCount, 1);
});

test('an async delay resolves before a manual retry', withServer, async (t, server, got) => {
	const attemptCounts: number[] = [];
	let requestCount = 0;

	server.get('/', (request, response) => {
		requestCount++;
		if (request.url === '/?done=true') {
			response.end('done');
			return;
		}

		response.end('retry');
	});

	const response = await got('', {
		retry: {
			async calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				await new Promise(resolve => {
					setTimeout(resolve, 20);
				});
				return attemptCount * 10;
			},
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.body === 'retry') {
						return retryWithMergedOptions({searchParams: {done: 'true'}});
					}

					return response;
				},
			],
		},
	}).text();

	t.is(response, 'done');
	t.deepEqual(attemptCounts, [1]);
	t.is(requestCount, 2);
});

test('enforceRetryRules permits manual retries but blocks subsequent disallowed status codes', withServer, async (t, server, got) => {
	const attemptCounts: number[] = [];
	let requestCount = 0;

	server.get('/', (_request, response) => {
		requestCount++;
		response.statusCode = 404;
		response.end('missing');
	});

	const error = await t.throwsAsync<HTTPError>(got('', {
		retry: {
			limit: 2,
			calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				return attemptCount;
			},
			statusCodes: [503],
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 404) {
						return retryWithMergedOptions({});
					}

					return response;
				},
			],
		},
	}));

	t.is(error.response.statusCode, 404);
	t.deepEqual(attemptCounts, [1]);
	t.is(requestCount, 2);
});

test('disabling enforceRetryRules allows an automatic retry after a manual retry', withServer, async (t, server, got) => {
	const attemptCounts: number[] = [];
	let requestCount = 0;

	server.get('/', (_request, response) => {
		requestCount++;
		if (requestCount >= 3) {
			response.end('done');
			return;
		}

		response.statusCode = 404;
		response.end('missing');
	});

	const response = await got('', {
		retry: {
			calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				return attemptCount;
			},
			statusCodes: [503],
			enforceRetryRules: false,
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 404) {
						return retryWithMergedOptions({searchParams: {done: 'true'}});
					}

					return response;
				},
			],
		},
	}).text();

	t.is(response, 'done');
	t.deepEqual(attemptCounts, [1, 2]);
	t.is(requestCount, 3);
});

test('a zero retry limit still permits a manual retry', withServer, async (t, server, got) => {
	const attemptCounts: number[] = [];
	let requestCount = 0;

	server.get('/', (request, response) => {
		requestCount++;
		if (request.url === '/?done=true') {
			response.end('done');
			return;
		}

		response.end('retry');
	});

	const response = await got('', {
		retry: {
			limit: 0,
			calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				return attemptCount;
			},
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.body === 'retry') {
						return retryWithMergedOptions({searchParams: {done: 'true'}});
					}

					return response;
				},
			],
		},
	}).text();

	t.is(response, 'done');
	t.deepEqual(attemptCounts, [1]);
	t.is(requestCount, 2);
});

test('response.retryCount and beforeRetry align with the attempt count', withServer, async (t, server, got) => {
	const attemptCounts: number[] = [];
	const retryCounts: number[] = [];
	const beforeRetryCounts: number[] = [];
	let requestCount = 0;

	server.get('/', (request, response) => {
		requestCount++;
		if (request.url === '/?done=true') {
			response.end('done');
			return;
		}

		response.end('retry');
	});

	const response = await got('', {
		retry: {
			calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				return attemptCount;
			},
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.body === 'retry') {
						return retryWithMergedOptions({searchParams: {done: 'true'}});
					}

					return response;
				},
			],
			beforeRetry: [
				(error, retryCount) => {
					beforeRetryCounts.push(retryCount);
					retryCounts.push(error.response?.retryCount ?? -1);
				},
			],
		},
	});

	t.is(response.body, 'done');
	t.deepEqual(attemptCounts, [1]);
	t.deepEqual(beforeRetryCounts, [1]);
	t.deepEqual(retryCounts, [0]);
	t.is(response.retryCount, 1);
});

test('a manual retry of an HTTP error body uses the ordinary attempt count', withServer, async (t, server, got) => {
	const attemptCounts: number[] = [];
	let requestCount = 0;

	server.get('/', (request, response) => {
		requestCount++;
		if (request.url === '/?done=true') {
			response.end('done');
			return;
		}

		response.statusCode = 503;
		response.end('unavailable');
	});

	const response = await got('', {
		throwHttpErrors: false,
		retry: {
			limit: 0,
			calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				return attemptCount;
			},
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.statusCode === 503) {
						return retryWithMergedOptions({searchParams: {done: 'true'}});
					}

					return response;
				},
			],
		},
	}).text();

	t.is(response, 'done');
	t.deepEqual(attemptCounts, [1]);
	t.is(requestCount, 2);
});

test('manual retry without preserveHooks drops remaining afterResponse hooks', withServer, async (t, server, got) => {
	const attemptCounts: number[] = [];
	const secondHookCalls: number[] = [];
	let requestCount = 0;

	server.get('/', (request, response) => {
		requestCount++;
		if (request.url === '/?attempt=2') {
			response.end('done');
			return;
		}

		response.end(`attempt-${requestCount}`);
	});

	const response = await got('', {
		retry: {
			limit: 3,
			calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				return attemptCount;
			},
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.body === 'attempt-1') {
						return retryWithMergedOptions({searchParams: {attempt: 2}});
					}

					return response;
				},
				response => {
					secondHookCalls.push(response.retryCount);
					return response;
				},
			],
		},
	}).text();

	t.is(response, 'done');
	t.deepEqual(attemptCounts, [1]);
	t.deepEqual(secondHookCalls, []);
	t.is(requestCount, 2);
});

test('a manual retry can request a method the default rules never retry', withServer, async (t, server, got) => {
	const attemptCounts: number[] = [];
	let requestCount = 0;

	server.post('/', (request, response) => {
		requestCount++;
		if (request.url === '/?done=true') {
			response.end('done');
			return;
		}

		response.end('retry');
	});

	const response = await got.post('', {
		body: 'payload',
		retry: {
			calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				return attemptCount;
			},
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.body === 'retry') {
						return retryWithMergedOptions({searchParams: {done: 'true'}});
					}

					return response;
				},
			],
		},
	}).text();

	t.is(response, 'done');
	t.deepEqual(attemptCounts, [1]);
	t.is(requestCount, 2);
});

test('a rejected async delay counts the attempt before failing', withServer, async (t, server, got) => {
	const attemptCounts: number[] = [];
	let requestCount = 0;

	server.get('/', (_request, response) => {
		requestCount++;
		response.end('body');
	});

	const error = await t.throwsAsync<RequestError>(got('', {
		retry: {
			async calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				throw new Error('async delay boom');
			},
		},
		hooks: {
			afterResponse: [
				(_response, retryWithMergedOptions) => retryWithMergedOptions({}),
			],
		},
	}));

	t.is(error.message, 'async delay boom');
	t.deepEqual(attemptCounts, [1]);
	t.is(requestCount, 1);
});

test('manual then automatic retries ascend counts with enforced rules', withServer, async (t, server, got) => {
	const attemptCounts: number[] = [];
	let requestCount = 0;

	server.get('/', (_request, response) => {
		requestCount++;
		if (requestCount >= 3) {
			response.end('done');
			return;
		}

		response.statusCode = requestCount === 2 ? 503 : 200;
		response.end('retry');
	});

	const response = await got('', {
		retry: {
			limit: 2,
			calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				return attemptCount;
			},
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.body === 'retry' && response.retryCount === 0) {
						// The first retry is manual; the automatic rule enforcement handles the next one.
						return retryWithMergedOptions({headers: {'x-manual': 'true'}});
					}

					return response;
				},
			],
		},
	}).text();

	t.is(response, 'done');
	t.deepEqual(attemptCounts, [1, 2]);
	t.is(requestCount, 3);
});

test('counts restart independently for separate requests', withServer, async (t, server, got) => {
	const attemptCounts: number[] = [];
	let requestCount = 0;

	server.get('/', (request, response) => {
		requestCount++;
		if (request.url === '/?done=true') {
			response.end('done');
			return;
		}

		response.end('retry');
	});

	const makeRequest = () => got('', {
		retry: {
			calculateDelay({attemptCount}) {
				attemptCounts.push(attemptCount);
				return attemptCount;
			},
		},
		hooks: {
			afterResponse: [
				(response, retryWithMergedOptions) => {
					if (response.body === 'retry') {
						return retryWithMergedOptions({searchParams: {done: 'true'}});
					}

					return response;
				},
			],
		},
	}).text();

	const [first, second] = await Promise.all([makeRequest(), makeRequest()]);

	t.is(first, 'done');
	t.is(second, 'done');
	t.deepEqual(attemptCounts, [1, 1]);
	t.is(requestCount, 4);
});
