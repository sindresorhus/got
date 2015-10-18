import test from 'ava';
import got from '../';
import {createServer} from './_server';

let s;

test.before('setup', async t => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.end(JSON.stringify(req.headers));
	});

	await s.listen(s.port);
});

test('user-agent', async t => {
	const headers = (await got(s.url, {json: true})).body;
	t.is(headers['user-agent'], 'https://github.com/sindresorhus/got');
});

test('accept-encoding', async t => {
	const headers = (await got(s.url, {json: true})).body;
	t.is(headers['accept-encoding'], 'gzip,deflate');
});

test('accept header with json option', async t => {
	const headers = (await got(s.url, {json: true})).body;
	t.is(headers.accept, 'application/json');
});

test('host', async t => {
	const headers = (await got(s.url, {json: true})).body;
	t.is(headers.host, `localhost:${s.port}`);
});

test('transform names to lowercase', async t => {
	const headers = (await got(s.url, {headers: {'USER-AGENT': 'test'}, json: true})).body;
	t.is(headers['user-agent'], 'test');
});

test.after('cleanup', async t => {
	await s.close();
});
