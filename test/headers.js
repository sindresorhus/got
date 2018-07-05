import fs from 'fs';
import path from 'path';
import test from 'ava';
import FormData from 'form-data';
import got from '../source';
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

test('user-agent', async t => {
	const headers = (await got(s.url, {json: true})).body;
	t.is(headers['user-agent'], `${pkg.name}/${pkg.version} (https://github.com/sindresorhus/got)`);
});

test('accept-encoding', async t => {
	const headers = (await got(s.url, {json: true})).body;
	t.is(headers['accept-encoding'], 'gzip, deflate');
});

test('do not override accept-encoding', async t => {
	const headers = (await got(s.url, {
		json: true,
		headers: {
			'accept-encoding': 'gzip'
		}
	})).body;
	t.is(headers['accept-encoding'], 'gzip');
});

test('do not set accept-encoding header when decompress options is false', async t => {
	const {body: headers} = await got(s.url, {
		json: true,
		decompress: false
	});
	t.false(Reflect.has(headers, 'accept-encoding'));
});

test('accept header with json option', async t => {
	let headers = (await got(s.url, {json: true})).body;
	t.is(headers.accept, 'application/json');

	headers = (await got(s.url, {
		headers: {
			accept: ''
		},
		json: true
	})).body;
	t.is(headers.accept, '');
});

test('host', async t => {
	const headers = (await got(s.url, {json: true})).body;
	t.is(headers.host, `localhost:${s.port}`);
});

test('transform names to lowercase', async t => {
	const headers = (await got(s.url, {
		headers: {
			'USER-AGENT': 'test'
		},
		json: true
	})).body;
	t.is(headers['user-agent'], 'test');
});

test('zero content-length', async t => {
	const {body} = await got(s.url, {
		headers: {
			'content-length': 0
		},
		body: 'sup'
	});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '0');
});

test('form-data manual content-type', async t => {
	const form = new FormData();
	form.append('a', 'b');
	const {body} = await got(s.url, {
		headers: {
			'content-type': 'custom'
		},
		body: form
	});
	const headers = JSON.parse(body);
	t.is(headers['content-type'], 'custom');
});

test('form-data automatic content-type', async t => {
	const form = new FormData();
	form.append('a', 'b');
	const {body} = await got(s.url, {
		body: form
	});
	const headers = JSON.parse(body);
	t.is(headers['content-type'], `multipart/form-data; boundary=${form.getBoundary()}`);
});

test('form-data sets content-length', async t => {
	const form = new FormData();
	form.append('a', 'b');
	const {body} = await got(s.url, {body: form});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '157');
});

test('stream as options.body sets content-length', async t => {
	const {body} = await got(s.url, {
		body: fs.createReadStream(path.join(__dirname, 'fixtures/stream-content-length'))
	});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '9');
});

test('remove null value headers', async t => {
	const {body} = await got(s.url, {
		headers: {
			'user-agent': null
		}
	});
	const headers = JSON.parse(body);
	t.false(Reflect.has(headers, 'user-agent'));
});

test('remove undefined value headers', async t => {
	const {body} = await got(s.url, {
		headers: {
			'user-agent': undefined
		}
	});
	const headers = JSON.parse(body);
	t.false(Reflect.has(headers, 'user-agent'));
});

test.after('cleanup', async () => {
	await s.close();
});
