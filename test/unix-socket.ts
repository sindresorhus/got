import {format} from 'util';
import test from 'ava';
import {Handler} from 'express';
import got from '../source';
import {withSocketServer} from './helpers/with-server';

const okHandler: Handler = (_request, response) => {
	response.end('ok');
};

if (process.platform !== 'win32') {
	test('works', withSocketServer, async (t, server) => {
		server.on('/', okHandler);

		const url = format('http://unix:%s:%s', server.socketPath, '/');
		t.is((await got(url)).body, 'ok');
	});

	test('protocol-less works', withSocketServer, async (t, server) => {
		server.on('/', okHandler);

		const url = format('unix:%s:%s', server.socketPath, '/');
		t.is((await got(url)).body, 'ok');
	});

	test('address with : works', withSocketServer, async (t, server) => {
		server.on('/foo:bar', okHandler);

		const url = format('unix:%s:%s', server.socketPath, '/foo:bar');
		t.is((await got(url)).body, 'ok');
	});

	test('throws on invalid URL', async t => {
		await t.throwsAsync(got('unix:'), {
			instanceOf: got.RequestError,
			code: 'ENOTFOUND'
		});
	});

	test('works when extending instances', withSocketServer, async (t, server) => {
		server.on('/', okHandler);

		const url = format('unix:%s:%s', server.socketPath, '/');
		const instance = got.extend({prefixUrl: url});
		t.is((await instance('')).body, 'ok');
	});
}
