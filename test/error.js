import test from 'ava';
import got from '../';
import {createServer} from './_server';

const s = createServer();

s.on('/', (req, res) => {
	res.statusCode = 404;
	res.end('not');
});

test.before('error - setup', t => {
	s.listen(s.port, () => t.end());
});

test('error - error message', t => {
	got(s.url, err => {
		t.ok(err);
		t.is(err.message, 'Response code 404 (Not Found)');
		t.is(err.host, `${s.host}:${s.port}`);
		t.is(err.method, 'GET');
		t.end();
	});
});

test('error - dns error message', t => {
	got('.com', err => {
		t.ok(err);
		t.regexTest(/getaddrinfo ENOTFOUND/, err.message);
		t.is(err.host, '.com');
		t.is(err.method, 'GET');
		t.end();
	});
});

test('error - options.body error message', t => {
	t.plan(2);
	t.throws(() => {
		got(s.url, {body: () => {}}, () => {});
	}, /options.body must be a ReadableStream, string, Buffer or plain Object/);

	got(s.url, {body: () => {}}).catch(err => {
		t.regexTest(/options.body must be a ReadableStream, string, Buffer or plain Object/, err.message);
	});
});

test.after('error - cleanup', t => {
	s.close();
	t.end();
});
