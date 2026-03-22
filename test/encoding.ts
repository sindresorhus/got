import {Buffer} from 'node:buffer';
import test from 'ava';
import withServer from './helpers/with-server.js';

test('encoding works with json', withServer, async (t, server, got) => {
	const json = {data: 'é'};

	server.get('/', (_request, response) => {
		response.set('Content-Type', 'application-json');
		response.send(Buffer.from(JSON.stringify(json), 'latin1'));
	});

	const response = await got('', {
		encoding: 'latin1',
		responseType: 'json',
	});

	t.deepEqual(response.body, json);
});

test('encoding works with text', withServer, async (t, server, got) => {
	const text = 'café';

	server.get('/', (_request, response) => {
		response.send(Buffer.from(text, 'latin1'));
	});

	const response = await got('', {
		encoding: 'latin1',
		responseType: 'text',
	});

	t.is(response.body, text);
});
