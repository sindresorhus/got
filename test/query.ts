import {URLSearchParams} from 'url';
import test from 'ava';
import withServer from './helpers/with-server';

// TODO: Remove this file before the Got v11 release together with completely removing the `query` option

const echoUrl = (request, response) => {
	response.end(request.url);
};

test('overrides query from options', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const {body} = await got(
		'?drop=this',
		{
			query: {
				test: 'wow'
			},
			cache: {
				get(key) {
					t.is(key, `cacheable-request:GET:${server.url}/?test=wow`);
				},
				set(key) {
					t.is(key, `cacheable-request:GET:${server.url}/?test=wow`);
				}
			}
		}
	);

	t.is(body, '/?test=wow');
});

test('escapes query parameter values', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const {body} = await got({
		query: {
			test: 'it’s ok'
		}
	});

	t.is(body, '/?test=it%E2%80%99s+ok');
});

test('the `query` option can be a URLSearchParams', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	const query = new URLSearchParams({test: 'wow'});
	const {body} = await got({query});
	t.is(body, '/?test=wow');
});

test('should ignore empty query object', withServer, async (t, server, got) => {
	server.get('/', echoUrl);

	t.is((await got({query: {}})).requestUrl, `${server.url}/`);
});

test('query option', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		t.is(request.query.recent, 'true');
		response.end('recent');
	});

	t.is((await got({query: {recent: true}})).body, 'recent');
	t.is((await got({query: 'recent=true'})).body, 'recent');
});

test('query in options are not breaking redirects', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('reached');
	});

	server.get('/relativeQuery', (request, response) => {
		t.is(request.query.bang, '1');

		response.writeHead(302, {
			location: '/'
		});
		response.end();
	});

	t.is((await got('relativeQuery', {query: 'bang=1'})).body, 'reached');
});
