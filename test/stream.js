import test from 'ava';
import got from '../';
import {createServer} from './_server';

const s = createServer();

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

test.before('stream - setup', t => {
	s.listen(s.port, () => t.end());
});

test('stream - json option can not be used in stream mode', t => {
	t.throws(() => {
		got.stream(s.url, {json: true});
	}, 'got can not be used as stream when options.json is used');
	t.end();
});

test('stream - callback can not be used in stream mode', t => {
	t.throws(() => {
		got.stream(s.url, {json: true}, () => {});
	}, 'callback can not be used in stream mode');

	t.throws(() => {
		got.stream(s.url, () => {});
	}, 'callback can not be used in stream mode');

	t.end();
});

test('stream - return readable stream', t => {
	got.stream(s.url)
		.on('data', data => {
			t.is(data.toString(), 'ok');
			t.end();
		});
});

test('stream - return writeable stream', t => {
	t.plan(1);
	got.stream.post(`${s.url}/post`)
		.on('data', data => {
			t.is(data.toString(), 'wow');
		})
		.end('wow');
});

test('stream - throws on write to stream with body specified', t => {
	t.throws(() => {
		got.stream(s.url, {body: 'wow'}).write('wow');
	}, 'got\'s stream is not writable when options.body is used');

	// wait for request to end
	setTimeout(t.end.bind(t), 10);
});

test('stream - request event', t => {
	got.stream(s.url)
		.on('request', req => {
			t.ok(req);
			t.end();
		});
});

test('stream - redirect event', t => {
	got.stream(`${s.url}/redirect`)
		.on('redirect', res => {
			t.is(res.headers.location, s.url);
			t.end();
		});
});

test('stream - response event', t => {
	got.stream(s.url)
		.on('response', res => {
			t.is(res.statusCode, 200);
			t.end();
		});
});

test('stream - error event', t => {
	got.stream(`${s.url}/error`)
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

test('stream - error event', t => {
	got.stream('.com')
		.on('response', () => {
			t.fail('response event should not be emitted');
		})
		.on('error', err => {
			t.regexTest(/getaddrinfo ENOTFOUND/, err.message);
			t.end();
		});
});

test.after('stream - cleanup', t => {
	s.close();
	t.end();
});
