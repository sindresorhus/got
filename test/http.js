import stream from 'stream';
import test from 'ava';
import getStream from 'get-stream';
import PCancelable from 'p-cancelable';
import got from '../';
import {createServer} from './helpers/server';

const Readable = stream.Readable;
let s;
let cancelPromise = null;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.end('ok');
	});

	s.on('/empty', (req, res) => {
		res.end();
	});

	s.on('/304', (req, res) => {
		res.statusCode = 304;
		res.end();
	});

	s.on('/404', (req, res) => {
		res.statusCode = 404;
		res.end('not');
	});

	s.on('/?recent=true', (req, res) => {
		res.end('recent');
	});

	s.on('/no-res-store-id', (req, res) => {
		cancelPromise = new Promise((resolve, reject) => {
			req.on('aborted', resolve);
			res.on('finish', () => {
				reject(new Error('Request finished instead of aborting'));
			});
		});

		getStream(req).then(() => {
			res.end();
		});
	});

	await s.listen(s.port);
});

test('simple request', async t => {
	t.is((await got(s.url)).body, 'ok');
});

test('protocol-less URLs', async t => {
	t.is((await got(s.url.replace(/^http:\/\//, ''))).body, 'ok');
});

test('empty response', async t => {
	t.is((await got(`${s.url}/empty`)).body, '');
});

test('requestUrl response', async t => {
	t.is((await got(s.url)).requestUrl, `${s.url}/`);
	t.is((await got(`${s.url}/empty`)).requestUrl, `${s.url}/empty`);
});

test('error with code', async t => {
	try {
		await got(`${s.url}/404`);
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.statusCode, 404);
		t.is(err.response.body, 'not');
	}
});

test('status code 304 doesn\'t throw', async t => {
	const p = got(`${s.url}/304`);
	await t.notThrows(p);
	const response = await p;
	t.is(response.statusCode, 304);
	t.is(response.body, '');
});

test('invalid protocol throws', async t => {
	const err = await t.throws(got('c:/nope.com', {json: true}));
	t.is(err.constructor, got.UnsupportedProtocolError);
});

test('buffer on encoding === null', async t => {
	const data = (await got(s.url, {encoding: null})).body;
	t.truthy(Buffer.isBuffer(data));
});

test('timeout option', async t => {
	try {
		await got(`${s.url}/404`, {
			timeout: 1,
			retries: 0
		});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.code, 'ETIMEDOUT');
	}
});

test('timeout option as object', async t => {
	try {
		await got(`${s.url}/404`, {
			timeout: {connect: 1},
			retries: 0
		});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.code, 'ETIMEDOUT');
	}
});

test('query option', async t => {
	t.is((await got(s.url, {query: {recent: true}})).body, 'recent');
	t.is((await got(s.url, {query: 'recent=true'})).body, 'recent');
});

test('requestUrl response when sending url as param', async t => {
	t.is((await got(s.url, {hostname: s.host, port: s.port})).requestUrl, `${s.url}/`);
	t.is((await got({hostname: s.host, port: s.port})).requestUrl, `${s.url}/`);
});

test('response contains url', async t => {
	t.is((await got(s.url)).url, `${s.url}/`);
});

test.serial('cancel in-progress request', async t => {
	const body = new Readable({
		read() {}
	});
	body.push('1');

	const p = got(`${s.url}/no-res-store-id`, {body});

	setImmediate(() => {
		p.cancel();
		body.push(null); // Complete the request that should now be canceled
	});

	await t.throws(p, PCancelable.CancelError);
	await t.notThrows(cancelPromise);
});

test.serial('cancel immediately', async t => {
	const p = got(`${s.url}/no-res-store-id`, {body: '', retries: 0});
	p.cancel();

	await t.throws(p, PCancelable.CancelError);
	await t.notThrows(cancelPromise);
});

test.after('cleanup', async () => {
	await s.close();
});
