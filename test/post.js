import test from 'ava';
import intoStream from 'into-stream';
import got from '../';
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
	let {body, headers} = await got.get(s.url, {body: 'hi'});
	t.is(body, 'hi');
	t.is(headers.method, 'GET');
});

test('sends strings', async t => {
	let {body} = await got(s.url, {body: 'wow'});
	t.is(body, 'wow');
});

test('sends Buffers', async t => {
	let {body} = await got(s.url, {body: new Buffer('wow')});
	t.is(body, 'wow');
});

test('sends Streams', async t => {
	let {body} = await got(s.url, {body: intoStream(['wow'])});
	t.is(body, 'wow');
});

test('works with empty post response', async t => {
	let {body} = await got(`${s.url}/empty`, {body: 'wow'});
	t.is(body, '');
});

test('content-length header with string body', async t => {
	let {body} = await got(`${s.url}/headers`, {body: 'wow', json: true});
	t.is(body['content-length'], '3');
});

test('content-length header with Buffer body', async t => {
	let {body} = await got(`${s.url}/headers`, {body: new Buffer('wow'), json: true});
	t.is(body['content-length'], '3');
});

test('content-length header with Stream body', async t => {
	let {body} = await got(`${s.url}/headers`, {body: intoStream(['wow']), json: true});
	t.is(body['content-length'], undefined);
});

test('content-length header is not overriden', async t => {
	let {body} = await got(`${s.url}/headers`, {
		body: 'wow',
		json: true,
		headers: {
			'content-length': '10'
		}
	});
	t.is(body['content-length'], '10');
});

test('content-length header disabled for chunked transfer-encoding', async t => {
	let {body} = await got(`${s.url}/headers`, {
		body: '3\r\nwow\r\n0\r\n',
		json: true,
		headers: {
			'transfer-encoding': 'chunked'
		}
	});
	t.is(body['content-length'], undefined);
});

test('object in options.body treated as querystring', async t => {
	let {body} = await got(s.url, {
		body: {
			such: 'wow'
		}
	});
	t.is(body, 'such=wow');
});

test('content-type header is not overriden when object in options.body', async t => {
	let {body} = await got(`${s.url}/headers`, {
		headers: {
			'content-type': 'doge'
		},
		body: {
			such: 'wow'
		},
		json: true
	});
	t.is(body['content-type'], 'doge');
});

test.after('cleanup', async () => {
	await s.close();
});
