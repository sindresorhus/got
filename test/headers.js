import test from 'ava';
import got from '../';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (req, res) => {
		req.resume();
		res.end(JSON.stringify(req.headers));
	});

	await s.listen(s.port);
});

test('user-agent', async t => {
	let headers = (await got(s.url, {json: true})).body;
	t.is(headers['user-agent'], 'https://github.com/sindresorhus/got');
});

test('accept-encoding', async t => {
	let headers = (await got(s.url, {json: true})).body;
	t.is(headers['accept-encoding'], 'gzip,deflate');
});

test('accept header with json option', async t => {
	let headers = (await got(s.url, {json: true})).body;
	t.is(headers.accept, 'application/json');

	headers = (await got(s.url, {headers: {accept: ''}, json: true})).body;
	t.is(headers.accept, '');
});

test('host', async t => {
	let headers = (await got(s.url, {json: true})).body;
	t.is(headers.host, `localhost:${s.port}`);
});

test('transform names to lowercase', async t => {
	let headers = (await got(s.url, {headers: {'USER-AGENT': 'test'}, json: true})).body;
	t.is(headers['user-agent'], 'test');
});

test('zero content-length', async t => {
	let headers = (await got(s.url, {headers: {'content-length': 0}, body: 'sup', json: true})).body;
	t.is(headers['content-length'], '0');
});

test.after('cleanup', async () => {
	await s.close();
});
