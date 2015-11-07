import test from 'ava';
import got from '../';
import intoStream from 'into-stream';
import {createServer} from './_server';

let s;

test.before('setup', async t => {
	s = await createServer();

	s.on('/', (req, res) => {
		res.end('ok');
	});

	s.on('/post', (req, res) => {
		req.pipe(res);
	});

	s.on('/redirect', (req, res) => {
		res.writeHead(302, {
			location: s.url
		});
		res.end();
	});

	s.on('/error', (req, res) => {
		res.statusCode = 404;
		res.end();
	});

	await s.listen(s.port);
});

test('option.json can not be used', t => {
	t.throws(() => {
		got.stream(s.url, {json: true});
	}, 'got can not be used as stream when options.json is used');
	t.end();
});

test('callback can not be used', t => {
	t.throws(() => {
		got.stream(s.url, {json: true}, () => {});
	}, 'callback can not be used with stream mode');

	t.throws(() => {
		got.stream(s.url, () => {});
	}, 'callback can not be used with stream mode');

	t.end();
});

test('returns readable stream', t => {
	got.stream(s.url)
		.on('data', data => {
			t.is(data.toString(), 'ok');
			t.end();
		});
});

test('returns writeable stream', t => {
	t.plan(1);
	got.stream.post(`${s.url}/post`)
		.on('data', data => {
			t.is(data.toString(), 'wow');
		})
		.end('wow');
});

test('throws on write to stream with body specified', t => {
	t.throws(() => {
		got.stream(s.url, {body: 'wow'}).write('wow');
	}, 'got\'s stream is not writable when options.body is used');

	// wait for request to end
	setTimeout(t.end.bind(t), 10);
});

test('have request event', t => {
	got.stream(s.url)
		.on('request', req => {
			t.ok(req);
			t.end();
		});
});

test('have redirect event', t => {
	got.stream(`${s.url}/redirect`)
		.on('redirect', res => {
			t.is(res.headers.location, s.url);
			t.end();
		});
});

test('have response event', t => {
	got.stream(s.url)
		.on('response', res => {
			t.is(res.statusCode, 200);
			t.end();
		});
});

test('have error event', t => {
	got.stream(`${s.url}/error`, {retries: 0})
		.on('response', () => {
			t.fail('response event should not be emitted');
		})
		.on('error', (err, data, res) => {
			t.is(err.message, 'Response code 404 (Not Found)');
			t.is(null, data);
			t.ok(res);
			t.end();
		});
});

test('have error event', t => {
	got.stream('.com', {retries: 0})
		.on('response', () => {
			t.fail('response event should not be emitted');
		})
		.on('error', err => {
			t.regexTest(/getaddrinfo ENOTFOUND/, err.message);
			t.end();
		});
});

test('accepts option.body as Stream', t => {
	got.stream(`${s.url}/post`, {body: intoStream(['wow'])})
		.on('data', chunk => {
			t.is(chunk.toString(), 'wow');
			t.end();
		});

});

test.after('cleanup', async t => {
	await s.close();
});
