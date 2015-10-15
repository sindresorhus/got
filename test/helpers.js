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
	got.get(s.url, (err, data) => {
		t.ifError(err);
		t.is(data, 'ok');
		t.end();
	});
});

test('helpers - promise mode', t => {
	t.plan(3);

	got.get(s.url).then(res => {
		t.is(res.body, 'ok');
	});

	got.get(`${s.url}/404`).catch(err => {
		t.is(err.response.body, 'not found');
	});

	got.get('.com', {retries: 0}).catch(err => {
		t.ok(err);
	});
});

test.after('helpers - cleanup', t => {
	s.close();
	t.end();
});
