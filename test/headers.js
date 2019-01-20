import fs from 'fs';
import {promisify} from 'util';
import path from 'path';
import test from 'ava';
import FormData from 'form-data';
import got from '../dist';
import supportsBrotli from '../dist/utils/supports-brotli';
import pkg from '../package';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	s.on('/', (request, response) => {
		request.resume();
		response.end(JSON.stringify(request.headers));
	});

	await s.listen(s.port);
});

test.after('cleanup', async () => {
	await s.close();
});

test('user-agent', async t => {
	const headers = await got(s.url).json();
	t.is(headers['user-agent'], `${pkg.name}/${pkg.version} (https://github.com/sindresorhus/got)`);
});

test('accept-encoding', async t => {
	const headers = await got(s.url).json();
	t.is(headers['accept-encoding'], supportsBrotli ? 'gzip, deflate, br' : 'gzip, deflate');
});

test('do not override accept-encoding', async t => {
	const headers = await got(s.url, {
		headers: {
			'accept-encoding': 'gzip'
		}
	}).json();
	t.is(headers['accept-encoding'], 'gzip');
});

test('do not remove user headers from `url` object argument', async t => {
	const headers = (await got({
		hostname: s.host,
		port: s.port,
		responseType: 'json',
		protocol: 'http:',
		headers: {
			'X-Request-Id': 'value'
		}
	})).body;

	t.is(headers.accept, 'application/json');
	t.is(headers['user-agent'], `${pkg.name}/${pkg.version} (https://github.com/sindresorhus/got)`);
	t.is(headers['accept-encoding'], supportsBrotli ? 'gzip, deflate, br' : 'gzip, deflate');
	t.is(headers['x-request-id'], 'value');
});

test('do not set accept-encoding header when decompress options is false', async t => {
	const headers = await got(s.url, {
		decompress: false
	}).json();
	t.false(Reflect.has(headers, 'accept-encoding'));
});

test('accept header with json option', async t => {
	let headers = await got(s.url).json();
	t.is(headers.accept, 'application/json');

	headers = await got(s.url, {
		headers: {
			accept: ''
		}
	}).json();
	t.is(headers.accept, '');
});

test('host', async t => {
	const headers = await got(s.url).json();
	t.is(headers.host, `localhost:${s.port}`);
});

test('transform names to lowercase', async t => {
	const headers = (await got(s.url, {
		headers: {
			'ACCEPT-ENCODING': 'identity'
		},
		responseType: 'json'
	})).body;
	t.is(headers['accept-encoding'], 'identity');
});

test('setting content-length to 0', async t => {
	const {body} = await got(s.url, {
		headers: {
			'content-length': 0
		},
		body: 'sup'
	});
	const headers = JSON.parse(body);
	t.is(headers['content-length'], '0');
});

test('sets content-length to 0 when requesting PUT with empty body', async t => {
	const {body} = await got(s.url, {
		method: 'PUT'
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
	const fixture = path.join(__dirname, 'fixtures/stream-content-length');
	const {size} = await promisify(fs.stat)(fixture);
	const {body} = await got(s.url, {
		body: fs.createReadStream(fixture)
	});
	const headers = JSON.parse(body);
	t.is(Number(headers['content-length']), size);
});

test('buffer as options.body sets content-length', async t => {
	const buffer = Buffer.from('unicorn');
	const {body} = await got(s.url, {
		body: buffer
	});
	const headers = JSON.parse(body);
	t.is(Number(headers['content-length']), buffer.length);
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

test('setting a header to undefined keeps the old value', async t => {
	const {body} = await got(s.url, {
		headers: {
			'user-agent': undefined
		}
	});
	const headers = JSON.parse(body);
	t.not(headers['user-agent'], undefined);
});

test('non-existent headers set to undefined are omitted', async t => {
	const {body} = await got(s.url, {
		headers: {
			blah: undefined
		}
	});
	const headers = JSON.parse(body);
	t.false(Reflect.has(headers, 'blah'));
});

test('preserve port in host header if non-standard port', async t => {
	const body = await got(s.url).json();
	t.is(body.host, 'localhost:' + s.port);
});

test('strip port in host header if explicit standard port (:80) & protocol (HTTP)', async t => {
	const body = await got('http://httpbin.org:80/headers').json();
	t.is(body.headers.Host, 'httpbin.org');
});

test('strip port in host header if explicit standard port (:443) & protocol (HTTPS)', async t => {
	const body = await got('https://httpbin.org:443/headers').json();
	t.is(body.headers.Host, 'httpbin.org');
});

test('strip port in host header if implicit standard port & protocol (HTTP)', async t => {
	const body = await got('http://httpbin.org/headers').json();
	t.is(body.headers.Host, 'httpbin.org');
});

test('strip port in host header if implicit standard port & protocol (HTTPS)', async t => {
	const body = await got('https://httpbin.org/headers').json();
	t.is(body.headers.Host, 'httpbin.org');
});
