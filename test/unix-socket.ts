import {format} from 'util';
import test from 'ava';
import got from '../source';
import {withSocketServer} from './helpers/with-server';

if (process.platform !== 'win32') {
	test('works', withSocketServer, async (t, server) => {
		server.on('/', (_request, response) => {
			response.end('ok');
		});

		const url = format('http://unix:%s:%s', server.socketPath, '/');
		t.is((await got(url)).body, 'ok');
	});

	test('protocol-less works', withSocketServer, async (t, server) => {
		server.on('/', (_request, response) => {
			response.end('ok');
		});

		const url = format('unix:%s:%s', server.socketPath, '/');
		t.is((await got(url)).body, 'ok');
	});

	test('address with : works', withSocketServer, async (t, server) => {
		server.on('/foo:bar', (_request, response) => {
			response.end('ok');
		});

		const url = format('unix:%s:%s', server.socketPath, '/foo:bar');
		t.is((await got(url)).body, 'ok');
	});

	test('throws on invalid URL', async t => {
		await t.throwsAsync(got('unix:'), {
			instanceOf: got.RequestError,
			code: 'ENOTFOUND'
		});
	});
}
