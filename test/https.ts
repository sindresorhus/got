import test from 'ava';
import got from '../source';
import withServer from './helpers/with-server';

test('https request without ca', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	t.truthy((await got({rejectUnauthorized: false})).body);
});

test('https request with ca', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const {body} = await got({
		ca: server.caCert,
		headers: {host: 'sindresorhus.com'}
	});
	t.is(body, 'ok');
});

test('http2', async t => {
	const promise = got('https://httpbin.org/anything', {
		http2: true
	});

	const {headers, body} = await promise;
	await promise.json();

	// @ts-ignore Pseudo headers may not be strings
	t.is(headers[':status'], 200);
	t.is(typeof body, 'string');
});
