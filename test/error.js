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

test('error - error message', async t => {
	try {
		await got(s.url);
		t.fail('Exception was not thrown');
	} catch (err) {
		t.ok(err);
		t.is(err.message, 'Response code 404 (Not Found)');
		t.is(err.host, `${s.host}:${s.port}`);
		t.is(err.method, 'GET');
	}
});

test('error - dns error message', async t => {
	try {
		await got('.com', {retries: 0});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.ok(err);
		t.regexTest(/getaddrinfo ENOTFOUND/, err.message);
		t.is(err.host, '.com');
		t.is(err.method, 'GET');
	}
});

test('error - options.body error message', async t => {
	try {
		got(s.url, {body: () => {}}, () => {});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.regexTest(/options.body must be a ReadableStream, string, Buffer or plain Object/, err.message);
	}

	try {
		await got(s.url, {body: () => {}});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.regexTest(/options.body must be a ReadableStream, string, Buffer or plain Object/, err.message);
	}
});

test.after('error - cleanup', t => {
	s.close();
	t.end();
});
