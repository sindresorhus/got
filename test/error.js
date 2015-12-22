import test from 'ava';
import got from '../';
import {createServer} from './_server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.statusCode = 404;
		res.end('not');
	});

	await s.listen(s.port);
});

test('properties', async t => {
	try {
		await got(s.url);
		t.fail('Exception was not thrown');
	} catch (err) {
		t.ok(err);
		t.ok(err.response);
		t.ok(!err.propertyIsEnumerable('response'));
		t.ok(!err.hasOwnProperty('code'));
		t.is(err.message, 'Response code 404 (Not Found)');
		t.is(err.host, `${s.host}:${s.port}`);
		t.is(err.method, 'GET');
	}
});

test('dns message', async t => {
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

test('options.body error message', async t => {
	try {
		await got(s.url, {body: () => {}});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.regexTest(/options.body must be a ReadableStream, string, Buffer or plain Object/, err.message);
	}
});

test.after('cleanup', async () => {
	await s.close();
});
