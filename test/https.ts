import test from 'ava';
import withServer from './helpers/with-server';

test('make request to https server without ca', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end('ok');
	});

	t.truthy((await got('', {rejectUnauthorized: false})).body);
});

test('make request to https server with ca', withServer, async (t, server, got) => {
	server.get('/', (request, response) => {
		response.end('ok');
	});

	const {body} = await got('', {
		ca: server.caCert,
		headers: {host: 'sindresorhus.com'}
	});
	t.is(body, 'ok');
});
