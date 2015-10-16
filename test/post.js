/**/

import test from 'ava';
import intoStream from 'into-stream';
import got from '../';
import {createServer} from './_server';

const s = createServer();

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

test.before('post - setup', async t => {
	await s.listen(s.port);
});

test('post - GET can have body', async t => {
	const {body, headers} = await got.get(s.url, {body: 'hi'});
	t.is(body, 'hi');
	t.is(headers.method, 'GET');
});

test('post - send data from options with post request', async t => {
	const {body} = await got(s.url, {body: 'wow'});
	t.is(body, 'wow');
});

test('post - send data from options with post request', async t => {
	const {body} = await got(s.url, {body: new Buffer('wow')});
	t.is(body, 'wow');
});

test('post - send data from options with post request', async t => {
	const {body} = await got(s.url, {body: intoStream(['wow'])});
	t.is(body, 'wow');
});

test('post - works with empty post response', async t => {
	const {body} = await got(`${s.url}/empty`, {body: 'wow'});
	t.is(body, '');
});

test('post - post have content-length header to string', async t => {
	const {body} = await got(`${s.url}/headers`, {body: 'wow', json: true});
	t.is(body['content-length'], '3');
});

test('post - post have content-length header to string', async t => {
	const {body} = await got(`${s.url}/headers`, {body: new Buffer('wow'), json: true});
	t.is(body['content-length'], '3');
});

test('post - post have content-length header to string', async t => {
	const {body} = await got(`${s.url}/headers`, {body: intoStream(['wow']), json: true});
	t.is(body['content-length'], undefined);
});

test('post - post have content-length header to string', async t => {
	const {body} = await got(`${s.url}/headers`, {
		body: 'wow',
		json: true,
		headers: {
			'content-length': '10'
		}
	});
	t.is(body['content-length'], '10');
});

test('post - post have content-length header to string', async t => {
	const {body} = await got(`${s.url}/headers`, {
		body: '3\r\nwow\r\n0\r\n',
		json: true,
		headers: {
			'transfer-encoding': 'chunked'
		}
	});
	t.is(body['content-length'], undefined);
});

test('post - works with plain object in body', async t => {
	const {body} = await got(s.url, {
		body: {
			such: 'wow'
		}
	});
	t.is(body, 'such=wow');
});

test('post - works with plain object in body', async t => {
	const {body} = await got(`${s.url}/headers`, {
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

test.after('post - cleanup', async t => {
	await s.close();
});
