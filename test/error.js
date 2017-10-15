import test from 'ava';
import createTestServer from 'create-test-server';
import got from '..';

let s;

test.before('setup', async () => {
	s = await createTestServer();

	s.get('/', (req, res) => {
		res.status(500).send('Error');
	});
});

test('properties', async t => {
	const err = await t.throws(got(s.url));
	t.truthy(err);
	t.truthy(err.response);
	t.false({}.propertyIsEnumerable.call(err, 'response'));
	t.false({}.hasOwnProperty.call(err, 'code'));
	t.is(err.message, 'Response code 500 (Internal Server Error)');
	t.is(err.host, `localhost:${s.port}`);
	t.is(err.method, 'GET');
	t.is(err.protocol, 'http:');
	t.is(err.url, err.response.requestUrl);
	t.is(err.headers.connection, 'close');
	t.is(err.response.body, 'Error');
});

test('dns message', async t => {
	const err = await t.throws(got('.com', {retries: 0}));
	t.truthy(err);
	t.regex(err.message, /getaddrinfo ENOTFOUND/);
	t.is(err.host, '.com');
	t.is(err.method, 'GET');
});

test('options.body error message', async t => {
	const err = await t.throws(got(s.url, {body: () => {}}));
	t.regex(err.message, /options\.body must be a ReadableStream, string, Buffer or plain Object/);
});

test.after('cleanup', async () => {
	await s.close();
});
