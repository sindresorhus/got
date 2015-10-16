import test from 'ava';
import got from '../';
import {createServer} from './_server';

const s = createServer();

s.on('/', (req, res) => {
	res.end('ok');
});

s.on('/404', (req, res) => {
	res.statusCode = 404;
	res.end('not found');
});

test.before('helpers - setup', t => {
	s.listen(s.port, () => t.end());
});

test('helpers - callback mode', t => {
	got.get(s.url, function (err, body) {
		t.ifError(err);
		t.is(body, 'ok');
		t.end();
	});
});

test('helpers - promise mode', async t => {
	t.is((await got.get(s.url)).body, 'ok');

	try {
		await got.get(`${s.url}/404`);
		t.fail('Exception is not thrown');
	} catch (err) {
		t.is(err.response.body, 'not found');
	}

	try {
		await got.get('.com', {retries: 0});
		t.fail('Exception is not thrown');
	} catch (err) {
		t.ok(err);
	}
});

test.after('helpers - cleanup', t => {
	s.close();
	t.end();
});
