import test from 'ava';
import got from '..';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.end('ok');
	});

	s.on('/404', (req, res) => {
		res.statusCode = 404;
		res.end('not found');
	});

	await s.listen(s.port);
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
