import test from 'ava';
import createTestServer from 'create-test-server';
import got from '..';

let s;

test.before('setup', async () => {
	s = await createTestServer({certificate: 'sindresorhus.com'});
	s.get('/', (req, res) => res.send('ok'));
});

test('make request to https server without ca', async t => {
	t.truthy((await got(s.sslUrl, {rejectUnauthorized: false})).body);
});

test('make request to https server with ca', async t => {
	const {body} = await got(s.sslUrl, {
		ca: s.caCert,
		headers: {host: 'sindresorhus.com'}
	});
	t.is(body, 'ok');
});

test.after('cleanup', async () => {
	await s.close();
});
