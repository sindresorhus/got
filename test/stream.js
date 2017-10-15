import test from 'ava';
import intoStream from 'into-stream';
import getStream from 'get-stream';
import createTestServer from 'create-test-server';
import got from '..';

let s;

test.before('setup', async () => {
	s = await createTestServer();

	s.get('/', (req, res) => {
		res.send('ok');
	});

	s.post('/', (req, res) => {
		req.pipe(res);
	});

	s.get('/redirect', (req, res) => {
		res.redirect(302, s.url);
	});
});

test('option.json can not be used', t => {
	t.throws(() => {
		got.stream(s.url, {json: true});
	}, 'got can not be used as stream when options.json is used');
});

test.cb('returns readable stream', t => {
	got.stream(s.url)
		.on('data', data => {
			t.is(data.toString(), 'ok');
			t.end();
		});
});

test.cb('returns writeable stream', t => {
	got.stream.post(s.url)
		.on('data', data => {
			t.is(data.toString(), 'wow');
			t.end();
		})
		.end('wow');
});

test.cb('throws on write to stream with body specified', t => {
	t.throws(() => {
		got.stream(s.url, {body: 'wow'}).write('wow');
	}, 'got\'s stream is not writable when options.body is used');

	// Wait for request to end
	setTimeout(t.end, 10);
});

test.cb('have request event', t => {
	got.stream(s.url)
		.on('request', req => {
			t.truthy(req);
			t.end();
		});
});

test.cb('have redirect event', t => {
	got.stream(`${s.url}/redirect`)
		.on('redirect', res => {
			t.is(res.headers.location, s.url);
			t.end();
		});
});

test.cb('have response event', t => {
	got.stream(s.url)
		.on('response', res => {
			t.is(res.statusCode, 200);
			t.end();
		});
});

test.cb('have error event', t => {
	got.stream(`${s.url}/404`, {retries: 0})
		.on('response', () => {
			t.fail('response event should not be emitted');
		})
		.on('error', (err, data, res) => {
			t.is(err.statusCode, 404);
			t.is(null, data);
			t.truthy(res);
			t.end();
		});
});

test.cb('have error event #2', t => {
	got.stream('.com', {retries: 0})
		.on('response', () => {
			t.fail('response event should not be emitted');
		})
		.on('error', err => {
			t.regex(err.message, /getaddrinfo ENOTFOUND/);
			t.end();
		});
});

test.cb('accepts option.body as Stream', t => {
	got.stream(s.url, {body: intoStream(['wow'])})
		.on('data', chunk => {
			t.is(chunk.toString(), 'wow');
			t.end();
		});
});

test.cb('redirect response contains old url', t => {
	got.stream(`${s.url}/redirect`)
		.on('response', res => {
			t.is(res.requestUrl, `${s.url}/redirect`);
			t.end();
		});
});

test('check for pipe method', t => {
	const stream = got.stream(`${s.url}/`);
	t.is(typeof stream.pipe, 'function');
	t.is(typeof stream.on('error', () => {}).pipe, 'function');
});

test('piping works', async t => {
	t.is(await getStream(got.stream(`${s.url}/`)), 'ok');
	t.is(await getStream(got.stream(`${s.url}/`).on('error', () => {})), 'ok');
});

test.after('cleanup', async () => {
	await s.close();
});
