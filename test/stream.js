import test from 'ava';
import intoStream from 'into-stream';
import got from '../';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
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
});

test.cb('returns readable stream', t => {
	got.stream(s.url)
		.on('data', data => {
			t.is(data.toString(), 'ok');
			t.end();
		});
});

test.cb('returns writeable stream', t => {
	got.stream.post(`${s.url}/post`)
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

	// wait for request to end
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
	got.stream(`${s.url}/error`, {retries: 0})
		.on('response', () => {
			t.fail('response event should not be emitted');
		})
		.on('error', (err, data, res) => {
			t.is(err.message, 'Response code 404 (Not Found)');
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
	got.stream(`${s.url}/post`, {body: intoStream(['wow'])})
		.on('data', chunk => {
			t.is(chunk.toString(), 'wow');
			t.end();
		});
});

test.after('cleanup', async () => {
	await s.close();
});
