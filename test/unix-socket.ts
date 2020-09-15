import {format} from 'util';
import test from 'ava';
import {Handler} from 'express';
import got from '../source';
import {withHttpSocketServer} from './helpers/with-server';

const okHandler: Handler = (_request, response) => {
	response.end('ok');
};

const testSkipWindows = process.platform === 'win32' ? test.skip : test;

testSkipWindows('works', withHttpSocketServer(), async (t, server) => {
	server.get('/', okHandler);

	const url = format('http://unix:%s:%s', server.socketPath, '/');
	t.is((await got(url)).body, 'ok');
});

testSkipWindows('protocol-less works', withHttpSocketServer(), async (t, server) => {
	server.get('/', okHandler);

	const url = format('unix:%s:%s', server.socketPath, '/');
	t.is((await got(url)).body, 'ok');
});

testSkipWindows('address with : works', withHttpSocketServer(), async (t, server) => {
	server.get('/foo:bar', okHandler);

	const url = format('unix:%s:%s', server.socketPath, '/foo:bar');
	t.is((await got(url)).body, 'ok');
});

testSkipWindows('throws on invalid URL', async t => {
	try {
		await got('unix:', {retry: 0});
	} catch (error) {
		t.regex(error.code, /ENOTFOUND|EAI_AGAIN/);
	}
});

testSkipWindows('works when extending instances', withHttpSocketServer(), async (t, server) => {
	server.get('/', okHandler);

	const url = format('unix:%s:%s', server.socketPath, '/');
	const instance = got.extend({prefixUrl: url});
	t.is((await instance('')).body, 'ok');
});

testSkipWindows('passes search params', withHttpSocketServer(), async (t, server) => {
	server.get('/?a=1', okHandler);

	const url = format('http://unix:%s:%s', server.socketPath, '/?a=1');
	t.is((await got(url)).body, 'ok');
});
