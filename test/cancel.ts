import EventEmitter from 'events';
import {Readable as ReadableStream} from 'stream';
import test from 'ava';
import pEvent from 'p-event';
// @ts-ignore
import got, {CancelError} from '../source';
import {createServer} from './helpers/server';

async function createAbortServer() {
	const s = await createServer();
	const ee = new EventEmitter();
	// @ts-ignore
	ee.aborted = new Promise((resolve, reject) => {
		s.on('/abort', async (request, response) => {
			ee.emit('connection');
			request.on('aborted', resolve);
			response.on('finish', reject.bind(null, new Error('Request finished instead of aborting.')));

			await pEvent(request, 'end');
			response.end();
		});

		s.on('/redirect', (request, response) => {
			response.writeHead(302, {
				location: `${s.url}/abort`
			});
			response.end();

			ee.emit('sentRedirect');

			setTimeout(resolve, 3000);
		});
	});

	await s.listen(s.port);
	// @ts-ignore
	ee.url = `${s.url}/abort`;
	// @ts-ignore
	ee.redirectUrl = `${s.url}/redirect`;

	return ee;
}

test('cancel do not retry after cancelation', async t => {
	const helper = await createAbortServer();

	// @ts-ignore
	const p = got(helper.redirectUrl, {
		retry: {
			retries: () => {
				t.fail('Makes a new try after cancelation');
			}
		}
	});

	helper.on('sentRedirect', () => {
		p.cancel();
	});

	// @ts-ignore
	await t.throwsAsync(p, CancelError);
	// @ts-ignore
	await t.notThrowsAsync(helper.aborted, 'Request finished instead of aborting.');
});

test('cancel in-progress request', async t => {
	const helper = await createAbortServer();
	const body = new ReadableStream({
		read() {}
	});
	body.push('1');

	// @ts-ignore
	const p = got.post(helper.url, {body});

	// Wait for the connection to be established before canceling
	helper.on('connection', () => {
		p.cancel();
		body.push(null);
	});

	// @ts-ignore
	await t.throwsAsync(p, CancelError);
	// @ts-ignore
	await t.notThrowsAsync(helper.aborted, 'Request finished instead of aborting.');
});

test('cancel in-progress request with timeout', async t => {
	const helper = await createAbortServer();
	const body = new ReadableStream({
		read() {}
	});
	body.push('1');

	// @ts-ignore
	const p = got.post(helper.url, {body, timeout: 10000});

	// Wait for the connection to be established before canceling
	helper.on('connection', () => {
		p.cancel();
		body.push(null);
	});

	await t.throwsAsync(p, CancelError);
	// @ts-ignore
	await t.notThrowsAsync(helper.aborted, 'Request finished instead of aborting.');
});

test('cancel immediately', async t => {
	const s = await createServer();
	const aborted = new Promise((resolve, reject) => {
		// We won't get an abort or even a connection
		// We assume no request within 1000ms equals a (client side) aborted request
		s.on('/abort', (request, response) => {
			response.on('finish', reject.bind(this, new Error('Request finished instead of aborting.')));
			response.end();
		});
		setTimeout(resolve, 1000);
	});

	await s.listen(s.port);

	const p = got(`${s.url}/abort`);
	p.cancel();
	await t.throwsAsync(p);
	await t.notThrowsAsync(aborted, 'Request finished instead of aborting.');
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
