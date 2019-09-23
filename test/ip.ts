import test from 'ava';
import withServer from './helpers/with-server';

test('ip is defined', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end();
	});

	const {ip} = await got('');

	t.is(ip, '127.0.0.1');
});
