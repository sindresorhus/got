import test from 'ava';
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
