import {format} from 'util';
import tempy from 'tempy';
import test from 'ava';
import got from '../source';
import {createServer} from './helpers/server';

const socketPath = tempy.file({extension: 'socket'});

let s;

if (process.platform !== 'win32') {
	test.before('setup', async () => {
		s = await createServer();

		s.on('/', (request, response) => {
			response.end('ok');
		});

		s.on('/foo:bar', (request, response) => {
			response.end('ok');
		});

		await s.listen(socketPath);
	});

	test.after('cleanup', async () => {
		await s.close();
	});

	test('works', async t => {
		const url = format('http://unix:%s:%s', socketPath, '/');
		t.is((await got(url)).body, 'ok');
	});

	test('protocol-less works', async t => {
		const url = format('unix:%s:%s', socketPath, '/');
		t.is((await got(url)).body, 'ok');
	});

	test('address with : works', async t => {
		const url = format('unix:%s:%s', socketPath, '/foo:bar');
		t.is((await got(url)).body, 'ok');
	});

	test('throws on invalid URL', async t => {
		await t.throwsAsync(got('unix:'));
	});
}
