import process from 'node:process';
import {format} from 'node:util';
import test from 'ava';
import type {Handler} from 'express';
import baseGot from '../source/index.js';
import {withSocketServer} from './helpers/with-server.js';

const got = baseGot.extend({enableUnixSockets: true});

const okHandler: Handler = (_request, response) => {
	response.end('ok');
};

const redirectHandler: Handler = (_request, response) => {
	response.writeHead(302, {
		location: 'foo',
	});
	response.end();
};

if (process.platform !== 'win32') {
	test('works', withSocketServer, async (t, server) => {
		server.on('/', okHandler);

		const url = format('http://unix:%s:%s', server.socketPath, '/');
		t.is((await got(url, {})).body, 'ok');
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
		try {
			await got('unix:', {retry: {limit: 0}});
		} catch (error: any) {
			t.regex(error.code, /ENOTFOUND|EAI_AGAIN/);
		}
	});

	test('works when extending instances', withSocketServer, async (t, server) => {
		server.on('/', okHandler);

		const url = format('unix:%s:%s', server.socketPath, '/');
		const instance = got.extend({prefixUrl: url});
		t.is((await instance('')).body, 'ok');
	});

	test('passes search params', withSocketServer, async (t, server) => {
		server.on('/?a=1', okHandler);

		const url = format('http://unix:%s:%s', server.socketPath, '/?a=1');
		t.is((await got(url)).body, 'ok');
	});

	test('redirects work', withSocketServer, async (t, server) => {
		server.on('/', redirectHandler);
		server.on('/foo', okHandler);

		const url = format('http://unix:%s:%s', server.socketPath, '/');
		t.is((await got(url)).body, 'ok');
	});

	test('`unix:` fails when UNIX sockets are not enabled', async t => {
		const gotUnixSocketsDisabled = got.extend({enableUnixSockets: false});

		t.false(gotUnixSocketsDisabled.defaults.options.enableUnixSockets);
		await t.throwsAsync(
			gotUnixSocketsDisabled('unix:'),
			{
				message: 'Using UNIX domain sockets but option `enableUnixSockets` is not enabled',
			},
		);
	});

	test('`http://unix:/` fails when UNIX sockets are not enabled', async t => {
		const gotUnixSocketsDisabled = got.extend({enableUnixSockets: false});

		t.false(gotUnixSocketsDisabled.defaults.options.enableUnixSockets);

		await t.throwsAsync(
			gotUnixSocketsDisabled('http://unix:'),
			{
				message: 'Using UNIX domain sockets but option `enableUnixSockets` is not enabled',
			},
		);
	});
}
