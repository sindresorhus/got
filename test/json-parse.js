import test from 'ava';
import createTestServer from 'create-test-server';
import got from '..';

let s;

test.before('setup', async () => {
	s = await createTestServer();

	s.get('/', (req, res) => {
		res.json({data: 'dog'});
	});

	s.get('/invalid', (req, res) => {
		res.end('/');
	});

	s.get('/no-body', (req, res) => {
		res.status(200).end();
	});

	s.get('/non200', (req, res) => {
		res.status(500).json({data: 'dog'});
	});

	s.get('/non200-invalid', (req, res) => {
		res.status(500).end('Internal error');
	});

	s.post('/headers', (req, res) => {
		res.json(req.headers);
	});
});

test('parses response', async t => {
	t.deepEqual((await got(s.url, {json: true})).body, {data: 'dog'});
});

test('not parses responses without a body', async t => {
	const {body} = await got(`${s.url}/no-body`, {json: true});
	t.is(body, '');
});

test('wraps parsing errors', async t => {
	const err = await t.throws(got(`${s.url}/invalid`, {json: true}));
	t.regex(err.message, /Unexpected token/);
	t.true(err.message.indexOf(err.hostname) !== -1, err.message);
	t.is(err.path, '/invalid');
});

test('parses non-200 responses', async t => {
	const err = await t.throws(got(`${s.url}/non200`, {json: true}));
	t.deepEqual(err.response.body, {data: 'dog'});
});

test('ignores errors on invalid non-200 responses', async t => {
	const err = await t.throws(got(`${s.url}/non200-invalid`, {json: true}));
	t.is(err.message, 'Response code 500 (Internal Server Error)');
	t.is(err.response.body, 'Internal error');
	t.is(err.path, '/non200-invalid');
});

test('should have statusCode in err', async t => {
	const err = await t.throws(got(`${s.url}/invalid`, {json: true}));
	t.is(err.constructor, got.ParseError);
	t.is(err.statusCode, 200);
});

test('should set correct headers', async t => {
	const {body: headers} = await got(`${s.url}/headers`, {json: true, body: {}});
	t.is(headers['content-type'], 'application/json');
	t.is(headers.accept, 'application/json');
});

test.after('cleanup', async () => {
	await s.close();
});
