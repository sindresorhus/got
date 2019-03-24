import test from 'ava';
import toReadableStream from 'to-readable-stream';
import got from '../source';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (request, response) => {
		response.setHeader('method', request.method);
		request.pipe(response);
	});

	s.on('/headers', (request, response) => {
		response.end(JSON.stringify(request.headers));
	});

	s.on('/empty', (request_, response) => {
		response.end();
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('GET cannot have body', async t => {
	await t.throwsAsync(got.get(s.url, {body: 'hi'}), 'The `GET` method cannot be used with a body');
});

test('sends strings', async t => {
	const {body} = await got.post(s.url, {body: 'wow'});
	t.is(body, 'wow');
});

test('sends Buffers', async t => {
	const {body} = await got.post(s.url, {body: Buffer.from('wow')});
	t.is(body, 'wow');
});

test('sends Streams', async t => {
	const {body} = await got.post(s.url, {body: toReadableStream('wow')});
	t.is(body, 'wow');
});

test('sends plain objects as forms', async t => {
	const {body} = await got.post(s.url, {
		form: {such: 'wow'}
	});
	t.is(body, 'such=wow');
});

test('does NOT support sending arrays as forms', async t => {
	await t.throwsAsync(got.post(s.url, {
		form: ['such', 'wow']
	}), TypeError);
});

test('sends plain objects as JSON', async t => {
	const {body} = await got.post(s.url, {
		json: {such: 'wow'},
		responseType: 'json'
	});
	t.deepEqual(body, {such: 'wow'});
});

test('sends arrays as JSON', async t => {
	const {body} = await got.post(s.url, {
		json: ['such', 'wow'],
		responseType: 'json'
	});
	t.deepEqual(body, ['such', 'wow']);
});

test('works with empty post response', async t => {
	const {body} = await got.post(`${s.url}/empty`, {body: 'wow'});
	t.is(body, '');
});

test('content-length header with string body', async t => {
	const {body} = await got.post(`${s.url}/headers`, {body: 'wow'});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '3');
});

test('content-length header with Buffer body', async t => {
	const {body} = await got.post(`${s.url}/headers`, {body: Buffer.from('wow')});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '3');
});

test('content-length header with Stream body', async t => {
	const {body} = await got.post(`${s.url}/headers`, {body: toReadableStream('wow')});
	const headers = JSON.parse(body);
	t.is(headers['transfer-encoding'], 'chunked', 'likely failed to get headers at all');
	t.is(headers['content-length'], undefined);
});

test('content-length header is not overriden', async t => {
	const {body} = await got.post(`${s.url}/headers`, {
		body: 'wow',
		headers: {
			'content-length': '10'
		}
	});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '10');
});

test('content-length header disabled for chunked transfer-encoding', async t => {
	const {body} = await got.post(`${s.url}/headers`, {
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
	const {body: headers} = await got.post(`${s.url}/headers`, {
		headers: {
			'content-type': 'doge'
		},
		json: {
			such: 'wow'
		},
		responseType: 'json'
	});
	t.is(headers['content-type'], 'doge');
});

test('throws when form body is not a plain object or array', async t => {
	await t.throwsAsync(got.post(`${s.url}`, {form: 'such=wow'}), TypeError);
});
