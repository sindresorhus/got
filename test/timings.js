import test from 'ava';
import got from '../source';
import {withServer} from './helpers/with-server';

// #687
test('sensible timings', withServer, async (t, s) => {
	s.get('/', (request, response) => {
		response.end('ok');
	});
	const {timings} = await got(s.url);
	t.true(timings.phases.request < 1000);
});
