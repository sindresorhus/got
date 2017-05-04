import test from 'ava';
import levelup from 'levelup';
import got from '../';
import {createServer} from './helpers/server';

let s;

test.before('setup', async () => {
	s = await createServer();

	let noCacheIndex = 0;
	s.on('/no-cache', (req, res) => {
		noCacheIndex++;
		res.end(noCacheIndex.toString());
	});

	let cacheIndex = 0;
	s.on('/cache', (req, res) => {
		cacheIndex++;
		res.setHeader('Cache-Control', 'public, max-age=60');
		res.end(cacheIndex.toString());
	});

	await s.listen(s.port);
});

test('Non cacheable requests are not cached', async t => {
	const cache = levelup('/no-cache', {db: require('memdown')});

	const firstResponse = parseInt((await got(`${s.url}/no-cache`, {cache})).body, 10);
	const secondResponse = parseInt((await got(`${s.url}/no-cache`, {cache})).body, 10);

	t.is(secondResponse, (firstResponse + 1));
});

test('Cacheable requests are cached', async t => {
	const cache = levelup('/cache', {db: require('memdown')});

	const firstResponse = await got(`${s.url}/cache`, {cache});
	const secondResponse = await got(`${s.url}/cache`, {cache});

	t.is(firstResponse.body, secondResponse.body);
});

test.after('cleanup', async () => {
	await s.close();
});
