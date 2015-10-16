import test from 'ava';
import got from '../';
import {createServer} from './_server';

const s = createServer();

s.on('/', (req, res) => {
	res.end(JSON.stringify(req.headers));
});

test.before('headers - setup', async t => {
	await s.listen(s.port);
});

test('headers - send user-agent header by default', async t => {
	const headers = (await got(s.url, {json: true})).body;
	t.is(headers['user-agent'], 'https://github.com/sindresorhus/got');
});

test('headers - send accept-encoding header by default', async t => {
	const headers = (await got(s.url, {json: true})).body;
	t.is(headers['accept-encoding'], 'gzip,deflate');
});

test('headers - send accept header with json option', async t => {
	const headers = (await got(s.url, {json: true})).body;
	t.is(headers.accept, 'application/json');
});

test('headers - send host header by default', async t => {
	const headers = (await got(s.url, {json: true})).body;
	t.is(headers.host, `localhost:${s.port}`);
});

test('headers - transform headers names to lowercase', async t => {
	const headers = (await got(s.url, {headers: {'USER-AGENT': 'test'}, json: true})).body;
	t.is(headers['user-agent'], 'test');
});

test.after('headers - cleanup', async t => {
	await s.close();
});
