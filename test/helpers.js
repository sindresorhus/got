import test from 'ava';
import createTestServer from 'create-test-server';
import got from '..';

let s;

test.before('setup', async () => {
	s = await createTestServer();

	s.get('/', (req, res) => {
		res.end('ok');
	});

	s.get('/404', (req, res) => {
		res.statusCode = 404;
		res.end('not found');
	});
});

test('promise mode', async t => {
	t.is((await got.get(s.url)).body, 'ok');

	const err = await t.throws(got.get(`${s.url}/404`));
	t.is(err.response.body, 'not found');

	const err2 = await t.throws(got.get('.com', {retries: 0}));
	t.truthy(err2);
});

test.after('cleanup', async () => {
	await s.close();
});
