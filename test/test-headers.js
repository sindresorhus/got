import test from 'ava';
import got from '../';
import {createServer} from './server.js';

const s = createServer();

s.on('/', (req, res) => {
	res.end(JSON.stringify(req.headers));
});

test.before('headers - setup', t => {
	s.listen(s.port, () => t.end());
});

test('headers - send user-agent header by default', t => {
	got(s.url, (err, data) => {
		t.ifError(err);

		const headers = JSON.parse(data);

		t.is(headers['user-agent'], 'https://github.com/sindresorhus/got');
		t.end();
	});
});

test('headers - send accept-encoding header by default', t => {
	got(s.url, (err, data) => {
		t.ifError(err);

		const headers = JSON.parse(data);

		t.is(headers['accept-encoding'], 'gzip,deflate');
		t.end();
	});
});

test('headers - send accept header with json option', t => {
	got(s.url, {json: true}, (err, headers) => {
		t.ifError(err);
		t.is(headers.accept, 'application/json');
		t.end();
	});
});

test('headers - send host header by default', t => {
	got(s.url, (err, data) => {
		t.ifError(err);

		const headers = JSON.parse(data);

		t.is(headers.host, `localhost:${s.port}`);
		t.end();
	});
});

test('headers - transform headers names to lowercase', t => {
	got(s.url, {headers: {'USER-AGENT': 'test'}}, (err, data) => {
		t.ifError(err);

		const headers = JSON.parse(data);

		t.is(headers['user-agent'], 'test');
		t.end();
	});
});

test.after('headers - cleanup', t => {
	s.close();
	t.end();
});
