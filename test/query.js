import {URLSearchParams} from 'url';
import test from 'ava';
import got from '../dist';
import {createServer} from './helpers/server';

// TODO: Remove this file before the Got v11 release together with completely removing the `query` option

let s;

test.before('setup', async () => {
	s = await createServer();

	const echoUrl = (request, response) => {
		response.end(request.url);
	};

	s.on('/', (request, response) => {
		response.statusCode = 404;
		response.end();
	});

	s.on('/test', echoUrl);
	s.on('/?test=wow', echoUrl);
	s.on('/?test=it’s+ok', echoUrl);

	s.on('/reached', (request, response) => {
		response.end('reached');
	});

	s.on('/relativeQuery?bang', (request, response) => {
		response.writeHead(302, {
			location: '/reached'
		});
		response.end();
	});

	s.on('/?recent=true', (request, response) => {
		response.end('recent');
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('overrides query from options', async t => {
	const {body} = await got(
		`${s.url}/?drop=this`,
		{
			query: {
				test: 'wow'
			},
			cache: {
				get(key) {
					t.is(key, `cacheable-request:GET:${s.url}/?test=wow`);
				},
				set(key) {
					t.is(key, `cacheable-request:GET:${s.url}/?test=wow`);
				}
			}
		}
	);

	t.is(body, '/?test=wow');
});

test('escapes query parameter values', async t => {
	const {body} = await got(`${s.url}`, {
		query: {
			test: 'it’s ok'
		}
	});

	t.is(body, '/?test=it%E2%80%99s+ok');
});

test('the `query` option can be a URLSearchParams', async t => {
	const query = new URLSearchParams({test: 'wow'});
	const {body} = await got(s.url, {query});
	t.is(body, '/?test=wow');
});

test('should ignore empty query object', async t => {
	t.is((await got(`${s.url}/test`, {query: {}})).requestUrl, `${s.url}/test`);
});

test('query option', async t => {
	t.is((await got(s.url, {query: {recent: true}})).body, 'recent');
	t.is((await got(s.url, {query: 'recent=true'})).body, 'recent');
});

test('query in options are not breaking redirects', async t => {
	t.is((await got(`${s.url}/relativeQuery`, {query: 'bang'})).body, 'reached');
});
