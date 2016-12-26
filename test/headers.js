import test from 'ava';
import FormData from 'form-data';
import got from '../';
import pkg from '../package';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (req, res) => {
		req.resume();
		res.end(JSON.stringify(req.headers));
	});

	await s.listen(s.port);
});

test.failing('user-agent', async t => {
	const headers = (await got(s.url, {parse: JSON.parse})).body;
	t.is(headers['user-agent'], `${pkg.name}/${pkg.version} (https://github.com/sindresorhus/got)`);
});

test.failing('accept-encoding', async t => {
	const headers = (await got(s.url, {parse: JSON.parse})).body;
	t.is(headers['accept-encoding'], 'gzip,deflate');
});

test.failing('accept header with json option', async t => {
	let headers = (await got(s.url, {parse: JSON.parse})).body;
	t.is(headers.accept, 'application/json');

	headers = (await got(s.url, {
		headers: {
			accept: ''
		},
		parse: JSON.parse
	})).body;
	t.is(headers.accept, '');
});

test.failing('host', async t => {
	const headers = (await got(s.url, {parse: JSON.parse})).body;
	t.is(headers.host, `localhost:${s.port}`);
});

test.failing('transform names to lowercase', async t => {
	const headers = (await got(s.url, {
		headers: {
			'USER-AGENT': 'test'
		},
		parse: JSON.parse
	})).body;
	t.is(headers['user-agent'], 'test');
});

test.failing('zero content-length', async t => {
	const headers = (await got(s.url, {
		headers: {
			'content-length': 0
		},
		body: 'sup',
		parse: JSON.parse
	})).body;
	t.is(headers['content-length'], '0');
});

test.failing('form-data manual content-type', async t => {
	const form = new FormData();
	form.append('a', 'b');
	const headers = (await got(s.url, {
		headers: {
			'content-type': 'custom'
		},
		body: form,
		parse: JSON.parse
	})).body;
	t.is(headers['content-type'], 'custom');
});

test.failing('form-data automatic content-type', async t => {
	const form = new FormData();
	form.append('a', 'b');
	const headers = (await got(s.url, {
		body: form,
		parse: JSON.parse
	})).body;
	t.is(headers['content-type'], `multipart/form-data; boundary=${form.getBoundary()}`);
});

test.after('cleanup', async () => {
	await s.close();
});
