import {EventEmitter} from 'events';
import {Readable as ReadableStream} from 'stream';
import test from 'ava';
import pEvent from 'p-event';
import getStream from 'get-stream';
// @ts-ignore
import got, {CancelError} from '../source';
import withServer from './helpers/with-server';
import slowDataStream from './helpers/slow-data-stream';

const prepareServer = server => {
	const emitter = new EventEmitter();

	const promise = new Promise((resolve, reject) => {
		server.all('/abort', async (request, response) => {
			emitter.emit('connection');
			request.once('aborted', resolve);
			response.once('finish', reject.bind(null, new Error('Request finished instead of aborting.')));

			await pEvent(request, 'end');
			response.end();
		});

		server.get('/redirect', (_request, response) => {
			response.writeHead(302, {
				location: `${server.url}/abort`
			});
			response.end();

			emitter.emit('sentRedirect');

			setTimeout(resolve, 3000);
		});
	});

	return {emitter, promise};
};

const downloadHandler = (_request, response) => {
	response.writeHead(200, {
		'transfer-encoding': 'chunked'
	});
	response.flushHeaders();
	slowDataStream().pipe(response);
};

test('does not retry after cancelation', withServer, async (t, server, got) => {
	const {emitter, promise} = prepareServer(server);

	const gotPromise = got('redirect', {
		retry: {
			retries: () => {
				t.fail('Makes a new try after cancelation');
			}
		}
	});

	emitter.once('sentRedirect', () => {
		gotPromise.cancel();
	});

	// @ts-ignore
	await t.throwsAsync(gotPromise, CancelError);
	// @ts-ignore
	await t.notThrowsAsync(promise, 'Request finished instead of aborting.');
});

test('cancels in-progress request', withServer, async (t, server, got) => {
	const {emitter, promise} = prepareServer(server);

	const body = new ReadableStream({
		read() {}
	});
	body.push('1');

	const gotPromise = got.post('abort', {body});

	// Wait for the connection to be established before canceling
	emitter.once('connection', () => {
		gotPromise.cancel();
		body.push(null);
	});

	await t.throwsAsync(gotPromise, CancelError);
	await t.notThrowsAsync(promise, 'Request finished instead of aborting.');
});

test('cancels in-progress request with timeout', withServer, async (t, server, got) => {
	const {emitter, promise} = prepareServer(server);

	const body = new ReadableStream({
		read() {}
	});
	body.push('1');

	const gotPromise = got.post('abort', {body, timeout: 10000});

	// Wait for the connection to be established before canceling
	emitter.once('connection', () => {
		gotPromise.cancel();
		body.push(null);
	});

	await t.throwsAsync(gotPromise, CancelError);
	await t.notThrowsAsync(promise, 'Request finished instead of aborting.');
});

test('cancel immediately', withServer, async (t, server, got) => {
	const promise = new Promise((resolve, reject) => {
		// We won't get an abort or even a connection
		// We assume no request within 1000ms equals a (client side) aborted request
		server.get('/abort', (_request, response) => {
			response.once('finish', reject.bind(this, new Error('Request finished instead of aborting.')));
			response.end();
		});

		setTimeout(resolve, 1000);
	});

	const gotPromise = got('abort');
	gotPromise.cancel();

	await t.throwsAsync(gotPromise);
	await t.notThrowsAsync(promise, 'Request finished instead of aborting.');
});

test('recover from cancelation using cancelable promise attribute', async t => {
	// Canceled before connection started
	const p = got('http://example.com');
	const recover = p.catch(error => {
		if (p.isCanceled) {
			return;
		}

		throw error;
	});

	p.cancel();

	await t.notThrowsAsync(recover);
});

test('recover from cancellation using error instance', async t => {
	// Canceled before connection started
	const p = got('http://example.com');
	const recover = p.catch(error => {
		if (error instanceof got.CancelError) {
			return;
		}

		throw error;
	});

	p.cancel();

	await t.notThrowsAsync(recover);
});

test('throws on incomplete (canceled) response - promise', withServer, async (t, server, got) => {
	server.get('/', downloadHandler);

	await t.throwsAsync(got({
		timeout: {request: 500}
	}), got.TimeoutError);
});

test('throws on incomplete (canceled) response - promise #2', withServer, async (t, server, got) => {
	server.get('/', downloadHandler);

	const promise = got('').on('response', () => {
		setTimeout(() => promise.cancel(), 500);
	});

	await t.throwsAsync(promise, got.CancelError);
});

test('throws on incomplete (canceled) response - stream', withServer, async (t, server, got) => {
	server.get('/', downloadHandler);

	const errorString = 'Foobar';

	const stream = got.stream('').on('response', () => {
		setTimeout(() => stream.destroy(new Error(errorString)), 500);
	});

	await t.throwsAsync(getStream(stream), errorString);
});

// Note: it will throw, but the response is loaded already.
test('throws when canceling cached request', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.setHeader('Cache-Control', 'public, max-age=60');
		response.end(Date.now().toString());
	});

	const cache = new Map();
	await got({cache});

	const promise = got({cache}).on('response', () => {
		promise.cancel();
	});

	await t.throwsAsync(promise, got.CancelError);
});
