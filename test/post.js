import test from 'ava';
import intoStream from 'into-stream';
import got from '..';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.setHeader('method', req.method);
		req.pipe(res);
	});

	s.on('/headers', (req, res) => {
		res.end(JSON.stringify(req.headers));
	});

	s.on('/empty', (req, res) => {
		res.end();
	});

	await s.listen(s.port);
});

test('GET can have body', async t => {
	const {body, headers} = await got.get(s.url, {body: 'hi'});
	t.is(body, 'hi');
	t.is(headers.method, 'GET');
});

test('sends strings', async t => {
	const {body} = await got(s.url, {body: 'wow'});
	t.is(body, 'wow');
});

test('sends Buffers', async t => {
	const {body} = await got(s.url, {body: Buffer.from('wow')});
	t.is(body, 'wow');
});

test('sends Streams', async t => {
	const {body} = await got(s.url, {body: intoStream(['wow'])});
	t.is(body, 'wow');
});

test('sends plain objects as forms', async t => {
	const {body} = await got(s.url, {
		body: {such: 'wow'},
		form: true
	});
	t.is(body, 'such=wow');
});

test('sends plain objects as JSON', async t => {
	const {body} = await got(s.url, {
		body: {such: 'wow'},
		json: true
	});
	t.deepEqual(body, {such: 'wow'});
});

test('works with empty post response', async t => {
	const {body} = await got(`${s.url}/empty`, {body: 'wow'});
	t.is(body, '');
});

test('content-length header with string body', async t => {
	const {body} = await got(`${s.url}/headers`, {body: 'wow'});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '3');
});

test('content-length header with Buffer body', async t => {
	const {body} = await got(`${s.url}/headers`, {body: Buffer.from('wow')});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '3');
});

test('content-length header with Stream body', async t => {
	const {body} = await got(`${s.url}/headers`, {body: intoStream(['wow'])});
	const headers = JSON.parse(body);
	t.is(headers['transfer-encoding'], 'chunked', 'likely failed to get headers at all');
	t.is(headers['content-length'], undefined);
});

test('content-length header is not overriden', async t => {
	const {body} = await got(`${s.url}/headers`, {
		body: 'wow',
		headers: {
			'content-length': '10'
		}
	});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '10');
});

test('content-length header disabled for chunked transfer-encoding', async t => {
	const {body} = await got(`${s.url}/headers`, {
		body: '3\r\nwow\r\n0\r\n',
		headers: {
			'transfer-encoding': 'chunked'
		}
	});
	const headers = JSON.parse(body);
	t.is(headers['transfer-encoding'], 'chunked', 'likely failed to get headers at all');
	t.is(headers['content-length'], undefined);
});

test('content-type header is not overriden when object in options.body', async t => {
	const {body: headers} = await got(`${s.url}/headers`, {
		headers: {
			'content-type': 'doge'
		},
		body: {
			such: 'wow'
		},
		json: true
	});
	t.is(headers['content-type'], 'doge');
});

test('throws when json body is not a plain object', async t => {
	await t.throws(got(`${s.url}`, {body: '{}', json: true}), TypeError);
});

test('throws when form body is not a plain object', async t => {
	await t.throws(got(`${s.url}`, {body: 'such=wow', form: true}), TypeError);
});

test.after('cleanup', async () => {
	await s.close();
});
