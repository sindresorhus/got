import test from 'ava';
import got from '../';
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

	try {
		await got.get(`${s.url}/404`);
		t.fail('Exception was not thrown');
	} catch (err) {
		t.is(err.response.body, 'not found');
	}

	try {
		await got.get('.com', {retries: 0});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.ok(err);
	}
});

test.after('cleanup', async () => {
	await s.close();
});
