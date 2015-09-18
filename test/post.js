import test from 'ava';
import intoStream from 'into-stream';
import got from '../';
import {createServer} from './_server';

const s = createServer();

s.on('/', (req, res) => {
	res.setHeader('method', req.method);
	req.pipe(res);
});

s.on('/headers', (req, res) => {
	res.end(JSON.stringify(req.headers));
});

s.on('/empty', (req, res) => {
	res.end();
});

test.before('post - setup', t => {
	s.listen(s.port, () => t.end());
});

test('post - GET can have body', t => {
	t.plan(3);

	got.get(s.url, {body: 'hi'}, (err, data, res) => {
		t.ifError(err);
		t.is(data, 'hi');
		t.is(res.headers.method, 'GET');
	});
});

test('post - send data from options with post request', t => {
	t.plan(6);

	got(s.url, {body: 'wow'}, (err, data) => {
		t.ifError(err);
		t.is(data, 'wow');
	});

	got(s.url, {body: new Buffer('wow')}, (err, data) => {
		t.ifError(err);
		t.is(data, 'wow');
	});

	got(s.url, {body: intoStream(['wow'])}, (err, data) => {
		t.ifError(err);
		t.is(data, 'wow');
	});
});

test('post - works with empty post response', t => {
	got(`${s.url}/empty`, {body: 'wow'}, (err, data) => {
		t.ifError(err);
		t.is(data, '');
		t.end();
	});
});

test('post - post have content-length header to string', t => {
	t.plan(10);

	got(`${s.url}/headers`, {
		body: 'wow',
		json: true
	}, (err, headers) => {
		t.ifError(err);
		t.is(headers['content-length'], '3');
	});

	got(`${s.url}/headers`, {
		body: new Buffer('wow'),
		json: true
	}, (err, headers) => {
		t.ifError(err);
		t.is(headers['content-length'], '3');
	});

	got(`${s.url}/headers`, {
		body: intoStream(['wow']),
		json: true
	}, (err, headers) => {
		t.ifError(err);
		t.is(headers['content-length'], undefined);
	});

	got(`${s.url}/headers`, {
		body: 'wow',
		json: true,
		headers: {
			'content-length': '10'
		}
	}, (err, headers) => {
		t.ifError(err);
		t.is(headers['content-length'], '10');
	});

	got(`${s.url}/headers`, {
		body: '3\r\nwow\r\n0\r\n',
		json: true,
		headers: {
			'transfer-encoding': 'chunked'
		}
	}, (err, headers) => {
		t.ifError(err);
		t.is(headers['content-length'], undefined);
	});
});

test('post - works with plain object in body', t => {
	t.plan(4);

	got(s.url, {
		body: {
			such: 'wow'
		}
	}, (err, data) => {
		t.ifError(err);
		t.is(data, 'such=wow');
	});

	got(`${s.url}/headers`, {
		headers: {
			'content-type': 'doge'
		},
		body: {
			such: 'wow'
		},
		json: true
	}, (err, headers) => {
		t.ifError(err);
		t.is(headers['content-type'], 'doge');
	});
});

test.after('post - cleanup', t => {
	s.close();
	t.end();
});
