import test from 'ava';
import got from '../';
import {createServer} from './helpers/server';

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
		t.truthy(err);
		t.truthy(err.response);
		t.false(err.propertyIsEnumerable('response'));
		t.false(err.hasOwnProperty('code'));
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
		t.truthy(err);
		t.regex(err.message, /getaddrinfo ENOTFOUND/);
		t.is(err.host, '.com');
		t.is(err.method, 'GET');
	}
});

test('options.body error message', async t => {
	try {
		await got(s.url, {body: () => {}});
		t.fail('Exception was not thrown');
	} catch (err) {
		t.regex(err.message, /options.body must be a ReadableStream, string, Buffer or plain Object/);
	}
});

test.after('cleanup', async () => {
	await s.close();
});
