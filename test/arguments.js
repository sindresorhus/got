import test from 'ava';
import got from '../';
import {createServer} from './_server';

const s = createServer();

s.on('/', (req, res) => {
	res.statusCode = 404;
	res.end();
});

s.on('/test', (req, res) => {
	res.end(req.url);
});

s.on('/?test=wow', (req, res) => {
	res.end(req.url);
});

test.before('arguments - setup', t => {
	s.listen(s.port, () => t.end());
});

test('arguments - url argument is required', t => {
	t.plan(2);
	t.throws(() => {
		got(undefined, () => {});
	}, /Parameter `url` must be a string or object, not undefined/);

	got().catch(err => {
		t.regexTest(/Parameter `url` must be a string or object, not undefined/, err.message);
	});
});

test('arguments - accepts url.parse object as first argument', t => {
	got({
		hostname: s.host,
		port: s.port,
		path: '/test'
	}, (err, data) => {
		t.ifError(err);
		t.is(data, '/test');
		t.end();
	});
});

test('arguments - overrides querystring from opts', t => {
	got(`${s.url}/?test=doge`, {query: {test: 'wow'}}, (err, data) => {
		t.ifError(err);
		t.is(data, '/?test=wow');
		t.end();
	});
});

test.after('arguments - cleanup', t => {
	s.close();
	t.end();
});
