import EventEmitter from 'events';
import stream from 'stream';
import test from 'ava';
import getStream from 'get-stream';
import PCancelable from 'p-cancelable';
import got from '..';
import {createServer} from './helpers/server';

const Readable = stream.Readable;

async function createAbortServer() {
	const s = await createServer();
	const ee = new EventEmitter();
	ee.aborted = new Promise((resolve, reject) => {
		s.on('/abort', (req, res) => {
			ee.emit('connection');
			req.on('aborted', resolve);
			res.on('finish', reject.bind(null, new Error('Request finished instead of aborting.')));

			getStream(req).then(() => {
				res.end();
			});
		});
	});

	await s.listen(s.port);
	ee.url = `${s.url}/abort`;

	return ee;
}

test('cancel in-progress request', async t => {
	const helper = await createAbortServer();
	const body = new Readable({
		read() {}
	});
	body.push('1');

	const p = got(helper.url, {body});

	// Wait for the connection to be established before canceling
	helper.on('connection', () => {
		p.cancel();
		body.push(null);
	});

	await t.throws(p, PCancelable.CancelError);
	await t.notThrows(helper.aborted, 'Request finished instead of aborting.');
});

test('cancel in-progress request with timeout', async t => {
	const helper = await createAbortServer();
	const body = new Readable({
		read() {}
	});
	body.push('1');

	const p = got(helper.url, {body, timeout: 10000});

	// Wait for the connection to be established before canceling
	helper.on('connection', () => {
		p.cancel();
		body.push(null);
	});

	await t.throws(p, PCancelable.CancelError);
	await t.notThrows(helper.aborted, 'Request finished instead of aborting.');
});

test('cancel immediately', async t => {
	const s = await createServer();
	const aborted = new Promise((resolve, reject) => {
		// We won't get an abort or even a connection
		// We assume no request within 1000ms equals a (client side) aborted request
		s.on('/abort', (req, res) => {
			res.on('finish', reject.bind(this, new Error('Request finished instead of aborting.')));
			res.end();
		});
		setTimeout(resolve, 1000);
	});

	await s.listen(s.port);

	const p = got(`${s.url}/abort`);
	p.cancel();
	await t.throws(p);
	await t.notThrows(aborted, 'Request finished instead of aborting.');
});

test('recover from cancelation using cancelable promise attribute', async t => {
	// Canceled before connection started
	const p = got('http://example.com');
	const recover = p.catch(err => {
		if (p.isCanceled) {
			return;
		}

		throw err;
	});

	p.cancel();

	await t.notThrows(recover);
});

test('recover from cancellation using error instance', async t => {
	// Canceled before connection started
	const p = got('http://example.com');
	const recover = p.catch(err => {
		if (err instanceof got.CancelError) {
			return;
		}

		throw err;
	});

	p.cancel();

	await t.notThrows(recover);
});
